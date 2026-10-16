package imgproxy

// Optional on-disk cache of upstream images (PROXY_CACHE_DIR).
//
// Layout: <dir>/<first 2 hex of key>/<key>, where key = hex(SHA-256(upstream
// URL)). The key is derived from the decrypted URL, not from the token, so
// entries survive a key rotation. Each entry is a single file:
//
//	<body bytes><meta JSON><meta length, 4 bytes big endian>
//
// The metadata trails the body because it is only complete after the body has
// been streamed (the upstream length may be unknown). One file means one
// rename publishes an entry atomically and one unlink removes it, so there is
// no body/metadata pair that can fall out of step. A file whose trailer does
// not parse, or whose recorded size does not match its length, is corrupt: it
// is deleted and served as a miss.
//
// Entries are written to a temp file beside their final path and renamed into
// place only when the whole image arrived. Concurrent misses for one URL may
// each fetch; the last rename wins and both results are identical.
//
// Eviction is least-recently-used by mtime: a hit touches the file, and when
// the accounted size exceeds the limit one background goroutine deletes the
// oldest files down to 90% of it.

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultCacheMaxBytes = 1 << 30 // 1 GiB, used when Config.CacheMaxBytes is not positive

	cacheDirMode = 0o700
	tempSuffix   = ".tmp"
	trailerLen   = 4       // big endian uint32: length of the metadata JSON before it
	maxMetaLen   = 4 << 10 // a trailer that claims more than this is corrupt
)

var errTooLargeForCache = errors.New("image is larger than the cache limit")

// entryMeta is what a cache hit needs to answer exactly like an upstream
// success: the pass-through response headers and the body length.
type entryMeta struct {
	ContentType     string `json:"content_type"`
	LastModified    string `json:"last_modified,omitempty"`
	ETag            string `json:"etag,omitempty"`
	ContentEncoding string `json:"content_encoding,omitempty"`
	Size            int64  `json:"size"`
}

// cacheKey is the entry name of an upstream URL.
func cacheKey(rawURL string) string {
	sum := sha256.Sum256([]byte(rawURL))
	return hex.EncodeToString(sum[:])
}

// diskCache is safe for concurrent use.
type diskCache struct {
	dir      string
	maxBytes int64

	mu       sync.Mutex
	size     int64 // accounted bytes of all entries
	evicting bool  // an eviction goroutine is running
}

// newConfiguredCache builds the cache named by cfg, or returns nil when it is
// off or cannot start. It never fails: a cache problem costs speed, not serving.
func newConfiguredCache(cfg Config) *diskCache {
	dir := strings.TrimSpace(cfg.CacheDir)
	if dir == "" {
		return nil
	}
	maxBytes := cfg.CacheMaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultCacheMaxBytes
	}
	c, err := newDiskCache(dir, maxBytes)
	if err != nil {
		log.Printf("imgproxy: disk cache disabled, %v", err)
		return nil
	}
	log.Printf("imgproxy: disk cache enabled at %s (limit %d MiB, %d MiB in use)", dir, maxBytes>>20, c.usedBytes()>>20)
	return c
}

// usedBytes is the accounted size of all entries.
func (c *diskCache) usedBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.size
}

// newDiskCache creates dir if needed, proves it is writable, and sizes what is
// already there. Temp files left by a crashed run are removed.
func newDiskCache(dir string, maxBytes int64) (*diskCache, error) {
	if err := os.MkdirAll(dir, cacheDirMode); err != nil {
		return nil, fmt.Errorf("cannot create %q: %w", dir, err)
	}
	// MkdirAll succeeds on an existing read-only directory, so write something.
	probe, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return nil, fmt.Errorf("%q is not writable: %w", dir, err)
	}
	closeErr := probe.Close()
	removeFile(probe.Name())
	if closeErr != nil {
		return nil, fmt.Errorf("%q is not writable: %w", dir, closeErr)
	}

	c := &diskCache{dir: dir, maxBytes: maxBytes}
	_, c.size = c.scan(true)
	if c.size > c.maxBytes {
		c.evicting = true
		go c.evict()
	}
	return c, nil
}

func (c *diskCache) entryPath(key string) string {
	return filepath.Join(c.dir, key[:2], key)
}

// has reports whether an entry exists for key. It does not validate it: a
// corrupt entry is dropped by open when a request meets it.
func (c *diskCache) has(key string) bool {
	info, err := os.Stat(c.entryPath(key))
	return err == nil && info.Mode().IsRegular()
}

// cachedImage is an open, validated entry. The caller closes it.
type cachedImage struct {
	file *os.File
	meta entryMeta
}

func (i *cachedImage) body() io.Reader { return io.NewSectionReader(i.file, 0, i.meta.Size) }

func (i *cachedImage) Close() error { return i.file.Close() }

// open returns the entry for key. A missing entry is a plain miss; an
// unreadable or corrupt one is deleted and is a miss too.
func (c *diskCache) open(key string) (*cachedImage, bool) {
	path := c.entryPath(key)
	f, err := os.Open(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("imgproxy: cannot open cache entry %s (%v)", key, err)
		}
		return nil, false
	}
	meta, err := readMeta(f)
	if err != nil {
		f.Close()
		log.Printf("imgproxy: dropping corrupt cache entry %s (%v)", key, err)
		c.drop(path)
		return nil, false
	}

	// Best effort: a failed touch only makes this entry look older to the LRU.
	now := time.Now()
	_ = os.Chtimes(path, now, now)
	return &cachedImage{file: f, meta: meta}, true
}

// readMeta parses and checks the trailer of an entry file.
func readMeta(f *os.File) (entryMeta, error) {
	var m entryMeta
	info, err := f.Stat()
	if err != nil {
		return m, err
	}
	total := info.Size()
	if total < trailerLen {
		return m, errors.New("shorter than a trailer")
	}

	var tail [trailerLen]byte
	if _, err := f.ReadAt(tail[:], total-trailerLen); err != nil {
		return m, err
	}
	n := int64(binary.BigEndian.Uint32(tail[:]))
	if n == 0 || n > maxMetaLen || n+trailerLen > total {
		return m, errors.New("bad metadata length")
	}
	raw := make([]byte, n)
	if _, err := f.ReadAt(raw, total-trailerLen-n); err != nil {
		return m, err
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return m, err
	}
	if m.Size <= 0 || m.Size != total-trailerLen-n || !isImageType(m.ContentType) {
		return m, errors.New("metadata does not match the file")
	}
	return m, nil
}

// drop deletes an entry and takes its bytes out of the accounting.
func (c *diskCache) drop(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	if removeFile(path) {
		c.size -= info.Size()
	}
}

// cacheFill is an entry being written. It is an io.Writer that never fails, so
// a cache problem (disk full) cannot interrupt the stream to the client: the
// first error is remembered, later writes are dropped, and commit reports it.
type cacheFill struct {
	cache *diskCache
	key   string
	file  *os.File
	n     int64
	err   error
}

func (c *diskCache) newFill(key string) (*cacheFill, error) {
	shard := filepath.Join(c.dir, key[:2])
	if err := os.MkdirAll(shard, cacheDirMode); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(shard, key+".*"+tempSuffix)
	if err != nil {
		return nil, err
	}
	return &cacheFill{cache: c, key: key, file: f}, nil
}

func (f *cacheFill) Write(b []byte) (int, error) {
	if f.err == nil {
		var n int
		n, f.err = f.file.Write(b)
		f.n += int64(n)
	}
	return len(b), nil
}

// commit publishes the entry. Whatever the outcome, the temp file is gone
// afterwards.
func (f *cacheFill) commit(meta entryMeta) error {
	err := f.finish(meta)
	if err != nil {
		f.abort()
	}
	return err
}

func (f *cacheFill) finish(meta entryMeta) error {
	if f.err != nil {
		return f.err
	}
	meta.Size = f.n
	trailer, err := encodeTrailer(meta)
	if err != nil {
		return err
	}
	size := f.n + int64(len(trailer))
	if size > f.cache.maxBytes {
		return errTooLargeForCache
	}
	if _, err := f.file.Write(trailer); err != nil {
		return err
	}
	if err := f.file.Close(); err != nil {
		return err
	}
	return f.cache.publish(f.file.Name(), f.key, size)
}

// abort closes and deletes the temp file.
func (f *cacheFill) abort() {
	// The file may already be closed; there is nothing to recover either way.
	_ = f.file.Close()
	removeFile(f.file.Name())
}

func encodeTrailer(m entryMeta) ([]byte, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	n := len(raw)
	out := append(raw, make([]byte, trailerLen)...)
	binary.BigEndian.PutUint32(out[n:], uint32(n))
	return out, nil
}

// publish renames a finished temp file over the entry path and accounts for
// it. The stat of a replaced entry and the rename share the lock, so two
// concurrent fills of one URL are counted once.
func (c *diskCache) publish(tmp, key string, size int64) error {
	final := c.entryPath(key)

	c.mu.Lock()
	defer c.mu.Unlock()
	var replaced int64
	if info, err := os.Stat(final); err == nil {
		replaced = info.Size()
	}
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	c.size += size - replaced
	if c.size > c.maxBytes && !c.evicting {
		c.evicting = true
		go c.evict()
	}
	return nil
}

type cacheFile struct {
	path  string
	size  int64
	mtime time.Time
}

// scan lists the entry files and their total size. Only names this cache
// creates are considered, so pointing PROXY_CACHE_DIR at a directory that holds
// anything else never puts those files at risk. With reap, temp files left by a
// crash are deleted, which is only safe before any fill is in flight.
func (c *diskCache) scan(reap bool) (files []cacheFile, total int64) {
	shards, err := os.ReadDir(c.dir)
	if err != nil {
		log.Printf("imgproxy: cannot list the cache dir (%v)", err)
		return nil, 0
	}
	for _, shard := range shards {
		if !shard.IsDir() || !isHexName(shard.Name(), 2) {
			continue
		}
		dir := filepath.Join(c.dir, shard.Name())
		items, err := os.ReadDir(dir)
		if err != nil {
			log.Printf("imgproxy: cannot list cache shard %s (%v)", dir, err)
			continue
		}
		for _, item := range items {
			path := filepath.Join(dir, item.Name())
			switch {
			case isHexName(item.Name(), 64):
				if info, err := item.Info(); err == nil && info.Mode().IsRegular() {
					files = append(files, cacheFile{path, info.Size(), info.ModTime()})
					total += info.Size()
				}
			case reap && isTempName(item.Name()):
				removeFile(path)
			}
		}
	}
	return files, total
}

// evict deletes the least recently used entries until the cache is at 90% of
// its limit. Only one runs at a time (evicting is set by whoever starts it) and
// it never holds the lock while it touches the disk, so serving is not blocked.
func (c *diskCache) evict() {
	defer func() {
		c.mu.Lock()
		c.evicting = false
		c.mu.Unlock()
	}()

	c.mu.Lock()
	sizeAtScan := c.size
	c.mu.Unlock()

	files, total := c.scan(false)
	sort.Slice(files, func(i, j int) bool { return files[i].mtime.Before(files[j].mtime) })

	target := c.maxBytes / 10 * 9
	for _, f := range files {
		if total <= target {
			break
		}
		if removeFile(f.path) {
			total -= f.size
		}
	}

	// Entries published while the scan ran moved c.size but may be missing from
	// total; carry that difference over. Any remaining error is bounded by a few
	// images and corrected by the next run.
	c.mu.Lock()
	c.size = total + (c.size - sizeAtScan)
	c.mu.Unlock()
}

// removeFile deletes path and reports whether it is gone (a file that was
// already missing counts as gone).
func removeFile(path string) bool {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("imgproxy: cannot remove %s (%v)", path, err)
		return false
	}
	return true
}

// isHexName reports whether name is exactly n lowercase hex digits.
func isHexName(name string, n int) bool {
	if len(name) != n {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// isTempName matches the temp files newFill creates: "<key>.<digits>.tmp".
func isTempName(name string) bool {
	return strings.HasSuffix(name, tempSuffix) && len(name) > 64 && name[64] == '.' && isHexName(name[:64], 64)
}
