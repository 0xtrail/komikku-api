# Komikku API
Restful API Manga bahasa Indonesia built with ❤️ and Go

# Usage
1. Clone this repository
    ```bash
    git clone https://github.com/Romi666/komikku-api.git
    ```
2. Init module
    ```
   go mod init komikku-api
   ```

3. Installing dependencies
    ```
   go mod download
   ```
4. Build binary file
   ```
   make build
   ```
5. Run program
   ```
   make start
   ```
# Configuration
Environment variables (or a `.env` file in the repository root):

| Variable   | Required | Description |
| ---------- | -------- | ----------- |
| `PORT`     | yes      | HTTP port the API listens on |
| `BASE_URL` | yes      | Upstream site, `https://komiku.org/` |
| `API_URL`  | no       | Upstream listing host, defaults to `https://api.komiku.org/` |
| `PROXY_HMAC_KEY` | no | Master key of the image proxy: standard base64 of exactly 32 bytes, generate one with `openssl rand -base64 32`. Empty or invalid (the API still boots, a warning is logged) leaves the proxy off |
| `PROXY_ALLOWED_HOSTS` | no | Comma separated hosts the proxy may fetch from, default `*.komiku.to,*.komiku.org`. `*.example.com` matches `example.com` and every subdomain, `host.tld` matches exactly |
| `PROXY_PUBLIC_URL` | no | Absolute base of the rewritten image URLs, e.g. `https://img2.example.com`. Empty derives it from each request (`X-Forwarded-Proto` + `Host`) |
| `PROXY_CACHE_DIR` | no | Directory of the image proxy's on-disk cache. Empty keeps the cache off, which is the default when running the binary directly; the Docker image defaults it to `/data/imgcache`. If the directory cannot be created or written the API still boots, a warning is logged and the cache stays off |
| `PROXY_CACHE_MAX_MB` | no | Size limit of that cache in MiB, default `1024`. A value that is not a positive integer logs one line and means the default |

## Image proxy
When `PROXY_HMAC_KEY` is set, every image URL in the responses (`image` of the comic listings,
`thumbnail` of comic info, `image` of chapter pages) is rewritten from the Komiku CDN host to
`<base>/img/<token>`, and `GET /img/<token>` streams the image from the origin. Clients then never
load images from Komiku directly, so Referer-based hotlink protection cannot break them and the CDN
hosts stay out of the responses.

   ```
   "image": "https://api.example.com/img/<token>"
   ```

The token is the original URL encrypted with AES-256-GCM (authenticated), so the host is not
readable and a token cannot be forged or edited. It is deterministic: the same URL always gives
the same token, which keeps browser and CDN caches stable. Responses are sent with
`Cache-Control: public, max-age=2592000, immutable`. Without a valid key nothing changes: image
URLs stay the raw CDN URLs and `/img/...` answers 404.

### Disk cache (optional)
By default every `/img/<token>` request fetches the image from the origin again. With
`PROXY_CACHE_DIR` set, an image that arrived completely (a `200` with an `image/*` type, within the
size cap, no transfer error, client still connected) is kept on disk and later requests are served
from there, without contacting the origin. Responses then carry `X-Cache: HIT` or `X-Cache: MISS`;
with the cache off the response headers are exactly as before.

- Token and host allowlist are checked before the cache is looked up, so a forged token still gets
  a 404 and a host removed from `PROXY_ALLOWED_HOSTS` is refused even if its images are cached.
- The entry name is the hex SHA-256 of the origin URL, in a subdirectory named after its first two
  hex characters. Eviction is least-recently-used (a hit touches the file): when the total exceeds
  `PROXY_CACHE_MAX_MB`, the oldest files are deleted down to 90% of it. There is no expiry other
  than eviction, which is fine because the CDN file names are not reused for other content.
- The directory must be writable and should be persistent. The Docker image creates `/data/imgcache`
  and defaults `PROXY_CACHE_DIR` to it, so mount a volume there (e.g. a Dokploy volume at
  `/data/imgcache`) or the cache is lost on every redeploy. Set `PROXY_CACHE_DIR=` (empty) to turn the
  cache off. Only files named like cache entries are ever deleted, so the directory may be shared
  with other files.

# Using Docker Compose
#### Build image and run container
   ```
   make up
   ```

#### Remove image and stop container
   ```
   make down
   ```

# API Collection

POSTMAN COLLECTION = https://www.getpostman.com/collections/4c984c36d27bb591c445


# API Output Example

## Get All Comic

#### Get Comic List

   ```
   https://komiku-api.fly.dev/api/comic/list
   https://komiku-api.fly.dev/api/comic/list?filter=manga
   https://komiku-api.fly.dev/api/comic/list?filter=manhwa
   https://komiku-api.fly.dev/api/comic/list?filter=manhua
   https://komiku-api.fly.dev/api/comic/list?page=2
   https://komiku-api.fly.dev/api/comic/list?filter=manhwa&page=2
   ```

`page` is optional (default 1). The upstream list is paginated with 50 comics per page.

#### Get Popular Comic
   ```
   https://komiku-api.fly.dev/api/comic/popular/page/1
   ```

#### Get Recommended Comic
   ```
   https://komiku-api.fly.dev/api/comic/recommended/page/1
   ```

#### Get Newest Comic
   ```
   https://komiku-api.fly.dev/api/comic/newest/page/1
   ```

### API Example
   ```
   {
    "success": true,
    "data": [
        {
            "title": "Super Mechanic (The Legendary Mechanic)",
            "image": "https://thumbnail.komiku.id/wp-content/uploads/2021/03/Komik-Super-Mechanic-The-Legendary-Mechanic.jpg",
            "desc": "Pemain game veteran Han Xiao dari “Xinghai” meninggal secara tak terduga selama power leveling.",
            "type": "Manhua",
            "endpoint": "/manga/super-mechanic-the-legendary-mechanic/"
        }
    ],
    "message": "Get All Comic",
    "code": 200
}
   ```

## Get Comic Info
   ```
   https://komiku-api.fly.dev/api/comic/info/{endpoint}
   ```

### API Example
   ```
   https://komiku-api.fly.dev/api/comic/info/manga/hack-g-u/
   ```
   ```
   {
    "success": true,
    "data": {
        "thumbnail": "https://thumbnail.komiku.id/wp-content/uploads/Komik-hackGU.jpg",
        "title": ".hack//G.U.+",
        "type": "Manga",
        "author": "Tatsuya Hamazaki & Yuzuka Morita",
        "status": "Ongoing",
        "rating": "15 Tahun (minimal)",
        "synopsis": "First paragraph of the synopsis.\n\nSecond paragraph, separated by one blank line.",
        "genre": [
            "Action",
            "Adventure",
            "Fantasy",
            "Magic",
            "Mecha"
        ],
        "chapter_list": [
            {
                "name": "Chapter 6",
                "endpoint": "/ch/hack-g-u-chapter-6/"
            },
            {
                "name": "Chapter 5",
                "endpoint": "/ch/hack-g-u-chapter-5/"
            },
            {
                "name": "Chapter 4",
                "endpoint": "/ch/hack-g-u-chapter-4/"
            },
            {
                "name": "Chapter 3",
                "endpoint": "/ch/hack-g-u-chapter-3/"
            },
            {
                "name": "Chapter 2",
                "endpoint": "/ch/hack-g-u-chapter-2/"
            },
            {
                "name": "Chapter 1",
                "endpoint": "/ch/hack-g-u-chapter-1/"
            }
        ]
    },
    "message": "Get Comic Info",
    "code": 200
}
   ```

`synopsis` is plain text: paragraphs are separated by exactly one blank line (`\n\n`), whitespace
inside a paragraph is collapsed, and it is an empty string when the comic has no synopsis.

## Search Comic
   ```
   https://komiku-api.fly.dev/api/comic/search/{query}
   ```

### API Example
   ```
   https://komiku-api.fly.dev/api/comic/search/one%20punch
   ```
   ```
   {
    "success": true,
    "data": [
        {
            "title": "One Punch Man",
            "image": "https://thumbnail.komiku.id/wp-content/uploads/Manga-One-Punch-Man.png",
            "desc": "Update 5 hari lalu. Saitama dapat melumpuhkan siapa saja dan apa pun hanya dengan satu pukulan.",
            "type": "Manga",
            "endpoint": "/manga/one-punch-man/"
        },
        {
            "title": "Onepunchman Saitama vs God",
            "image": "https://thumbnail.komiku.id/wp-content/uploads/Manga-Onepunchman-Saitama-vs-God.jpg",
            "desc": "Update 2 tahun lalu. Berputar di sekitar pahlawan super tituler yang telah berlatih sangat keras sehingga rambutnya rontok.",
            "type": "Manga",
            "endpoint": "/manga/onepunchman-saitama-vs-god/"
        },
        {
            "title": "One-Punch Man (ONE)",
            "image": "https://thumbnail.komiku.id/wp-content/uploads/Manga-One-Punch-Man-ONE.jpg",
            "desc": "Update 9 bulan lalu. Santai, berkepala dingin, dan terasa botak, Saitama memiliki penampilan seorang pria dewasa yang tidak berbahaya.",
            "type": "Manga",
            "endpoint": "/manga/one-punch-man-one/"
        },
        {
            "title": "Here’s a Punch",
            "image": "https://thumbnail.komiku.id/wp-content/uploads/2021/09/Komik-Heres-a-Punch.png",
            "desc": "Update 4 bulan lalu.  Li Xing, seorang mahasiswa, menemukan pekerjaan dengan bantuan mandor yang antusias. Tanpa diduga, kontraktor memiliki latar~",
            "type": "Manhua",
            "endpoint": "/manga/heres-a-punch/"
        },
        {
            "title": "Fire Punch",
            "image": "https://thumbnail.komiku.id/wp-content/uploads/2020/09/Komik-Fire-Punc.jpg",
            "desc": "Update 1 tahun lalu. Di masa lalu yang tidak terlalu lama, Penyihir Es menyelimuti dunia dengan salju.",
            "type": "Manga",
            "endpoint": "/manga/fire-punch-2/"
        }
    ],
    "message": "Search manga",
    "code": 200
}
   ```

## Get Chapter Detail
   ```
   https://komiku-api.fly.dev/api/comic/chapter{endpoint chapter}
   ```

### API Example
   ```
   https://komiku-api.fly.dev/api/comic/chapter/ch/hack-g-u-chapter-1/
   ```
   ```
   {
    "success": true,
    "data": {
        "title": ".hack//G.U.+ Chapter 6",
        "image": [
            "https://cdn.komiku.co.id/wp-content/uploads/85998-1.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-2.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-3.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-4.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-5.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-6.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-7.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-8.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-9.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-10.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-11.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-12.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-13.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-14.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-15.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-16.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-17.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-18.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-19.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-20.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-21.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-22.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-23.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-24.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-25.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-26.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-27.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-28.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-29.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-30.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-31.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-32.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-33.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-34.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-35.jpg",
            "https://cdn.komiku.co.id/wp-content/uploads/85998-36.jpg"
        ]
    },
    "message": "Get Chapter Detail",
    "code": 200
}
   ```