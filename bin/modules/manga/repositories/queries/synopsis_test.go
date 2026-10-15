package queries

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gocolly/colly"
	"komikku-api/bin/config"
	"komikku-api/bin/modules/manga/models/domain"
)

// The queries package imports config, whose init() panics unless PORT and
// BASE_URL are set, so run these tests with:
//
//	PORT=0 BASE_URL=https://komiku.org/ go test ./bin/modules/manga/...
func TestNormalizeSynopsis(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"empty", "", ""},
		{"whitespace only", " \n\t \r\n  ", ""},
		{"single paragraph is trimmed", "\n  One Piece bercerita.  \n", "One Piece bercerita."},
		{"blank line splits paragraphs", "Satu.\n\nDua.", "Satu.\n\nDua."},
		{"many blank lines still join with one blank line", "Satu.\n\n\n\n\nDua.", "Satu.\n\nDua."},
		{"blank line holding spaces and tabs", "Satu.\n \t \nDua.", "Satu.\n\nDua."},
		{"crlf line endings", "Satu.\r\n\r\nDua.\r\nlanjut.", "Satu.\n\nDua. lanjut."},
		{"single newline inside a paragraph becomes a space", "kata\nberikut", "kata berikut"},
		{"runs of whitespace collapse", "a  b\t\tc   d", "a b c d"},
		{"leading and trailing blank paragraphs are dropped", "\n\n  \n\nIsi.\n\n \n", "Isi."},
		{"empty paragraphs between real ones are dropped", "A.\n\n \n\n\t\n\nB.", "A.\n\nB."},
		{"three paragraphs", "A.\n\nB b.\n\nC.", "A.\n\nB b.\n\nC."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeSynopsis(tt.raw); got != tt.want {
				t.Errorf("normalizeSynopsis(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

// synopsisPages are info pages as the upstream serves them, keyed by endpoint.
var synopsisPages = map[string]string{
	// p.desc wins over the hidden copy, a <br> is a line break, not glue.
	"/manga/visible/": `<table class="inftable"><tr><td>Judul:</td><td>Visible</td></tr></table>
<h2>Sinopsis</h2>
<p class="desc" itemprop="description">
Satu
dua.

Tiga<br>empat.</p>
<section class="sec" id="Sinopsis" style="display:none"><h2>Sinopsis Lengkap</h2><p>Salinan tersembunyi.</p></section>`,
	// no p.desc: the first paragraph of the hidden section is used.
	"/manga/hidden/": `<section class="sec" id="Sinopsis" style="display:none"><h2>Sinopsis Lengkap</h2>
<p>Salinan pertama.</p><p>Salinan kedua.</p></section>`,
	// an empty p.desc does not block the fallback.
	"/manga/empty-desc/": `<p class="desc"> </p>
<section id="Sinopsis"><p>Dari bagian tersembunyi.</p></section>`,
	// no synopsis anywhere: empty string, not an error.
	"/manga/none/": `<table class="inftable"><tr><td>Judul:</td><td>None</td></tr></table>`,
}

func TestGetComicInfoSynopsis(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, ok := synopsisPages[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<html><body>"+page+"</body></html>")
	}))
	defer srv.Close()

	oldBase := config.GlobalEnv.BaseURL
	config.GlobalEnv.BaseURL = srv.URL + "/"
	defer func() { config.GlobalEnv.BaseURL = oldBase }()

	tests := []struct {
		endpoint string
		want     string
	}{
		{"/manga/visible/", "Satu dua.\n\nTiga empat."},
		{"/manga/hidden/", "Salinan pertama."},
		{"/manga/empty-desc/", "Dari bagian tersembunyi."},
		{"/manga/none/", ""},
	}
	for _, tt := range tests {
		t.Run(tt.endpoint, func(t *testing.T) {
			res := NewMangaQuery("", colly.NewCollector()).GetComicInfo(tt.endpoint)
			if res.Error != nil {
				t.Fatalf("unexpected error: %v", res.Error)
			}
			info, ok := res.Data.(domain.ComicInfo)
			if !ok {
				t.Fatalf("Data is %T, want domain.ComicInfo", res.Data)
			}
			if info.Synopsis != tt.want {
				t.Errorf("Synopsis = %q, want %q", info.Synopsis, tt.want)
			}
		})
	}
}
