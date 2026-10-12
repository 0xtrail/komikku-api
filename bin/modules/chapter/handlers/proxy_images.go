package handlers

import (
	"github.com/labstack/echo/v4"
	chapterM "komikku-api/bin/modules/chapter/models/domain"
)

// proxyImages rewrites the page images of a chapter to the image proxy
// (/img/<token>). Data that carries no image, and every result while the proxy
// is disabled, is returned as is. The image slice is copied, never edited in place.
func (c *ChapterHandler) proxyImages(ctx echo.Context, data interface{}) interface{} {
	if !c.imgProxy.Enabled() {
		return data
	}
	detail, ok := data.(chapterM.ChapterDetail)
	if !ok || detail.Image == nil {
		return data
	}

	base := c.imgProxy.PublicBase(ctx)
	images := make([]string, len(detail.Image))
	for i, img := range detail.Image {
		images[i] = c.imgProxy.Rewrite(base, img)
	}
	detail.Image = images
	return detail
}
