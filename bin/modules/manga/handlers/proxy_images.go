package handlers

import (
	"github.com/labstack/echo/v4"
	mangaM "komikku-api/bin/modules/manga/models/domain"
)

// proxyImages rewrites the image URLs of a successful result to the image proxy
// (/img/<token>). Data that carries no image, and every result while the proxy
// is disabled, is returned as is. Slices are copied, never edited in place.
func (m *MangaHandler) proxyImages(c echo.Context, data interface{}) interface{} {
	if !m.imgProxy.Enabled() {
		return data
	}
	base := m.imgProxy.PublicBase(c)

	switch v := data.(type) {
	case []mangaM.Comic:
		out := make([]mangaM.Comic, len(v))
		copy(out, v)
		for i := range out {
			out[i].Image = m.imgProxy.Rewrite(base, out[i].Image)
		}
		return out
	case mangaM.ComicInfo:
		v.Thumbnail = m.imgProxy.Rewrite(base, v.Thumbnail)
		return v
	}
	return data
}
