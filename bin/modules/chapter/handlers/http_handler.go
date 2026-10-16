package handlers

import (
	"github.com/gocolly/colly"
	"github.com/labstack/echo/v4"
	"komikku-api/bin/config"
	chapterQ "komikku-api/bin/modules/chapter/repositories/queries"
	chapterU "komikku-api/bin/modules/chapter/usecases"
	"komikku-api/bin/pkg/imgproxy"
	"komikku-api/bin/pkg/prewarm"
	"komikku-api/bin/pkg/utils"
	"net/http"
)

type ChapterHandler struct {
	chapterCommandUsecase chapterU.ChapterUsecase
	imgProxy              *imgproxy.Proxy
	prewarm               prewarm.Enqueuer
	recent                *prewarm.Recent
	nextSlots             chan struct{}
}


// New builds the handler with the Recent set that keeps chapters from being
// prewarmed twice.
func New(imgProxy *imgproxy.Proxy, recent *prewarm.Recent) *ChapterHandler {
	collector := colly.NewCollector()
	queryChapter := chapterQ.NewChapterQuery(config.GlobalEnv.BaseURL, collector)
	queryUsecase := chapterU.CreateNewChapterUsecase(queryChapter)
	return &ChapterHandler{
		chapterCommandUsecase: queryUsecase,
		imgProxy:              imgProxy,
		prewarm:               imgProxy,
		recent:                recent,
		nextSlots:             make(chan struct{}, nextChapterSlots),
	}
}

func (c *ChapterHandler) Mount(router *echo.Echo)  {
	api := router.Group("/api")
	api.GET("/comic/chapter/:endpoint", c.GetChapterDetail)
}

func(m *ChapterHandler) GetChapterDetail(c echo.Context) error {
	endpoint := c.Param("endpoint")
	result := m.chapterCommandUsecase.GetChapterDetail(endpoint)

	if result.Error != nil {
		return utils.ResponseError(result.Error, c)
	}

	m.prewarmChapters(endpoint, result.Data)
	return utils.Response(m.proxyImages(c, result.Data), "Get Chapter Detail", http.StatusOK, c)
}
