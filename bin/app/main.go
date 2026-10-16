package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/gocolly/colly"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"komikku-api/bin/config"
	chapterH "komikku-api/bin/modules/chapter/handlers"
	chapterQ "komikku-api/bin/modules/chapter/repositories/queries"
	mangaH "komikku-api/bin/modules/manga/handlers"
	mangaQ "komikku-api/bin/modules/manga/repositories/queries"
	"komikku-api/bin/pkg/imgproxy"
	"komikku-api/bin/pkg/middlewares"
	"komikku-api/bin/pkg/prewarm"
	"komikku-api/bin/pkg/utils"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const (
	// recentChapters bounds the memory of chapters prewarmed lately.
	recentChapters = 5000
	// scheduleStartDelay keeps a restart from scraping the site at once.
	scheduleStartDelay = 30 * time.Second
	// scheduleSkip is how long a chapter the scheduler prewarmed is left alone.
	scheduleSkip = 6 * time.Hour
	// schedulePause separates the titles of one scheduled cycle.
	schedulePause = 2 * time.Second
	// shutdownGrace is how long in-flight requests get after SIGINT or SIGTERM.
	shutdownGrace = 10 * time.Second
)

func main() {
	//Echo instance
	e := echo.New()

	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: config.GlobalEnv.AllowedOrigins,
	}))
	e.Use(middleware.Recover())
	e.Use(middlewares.Logger())

	// One image proxy shared by the handlers that rewrite image URLs and the
	// /img/:token route that serves them. Disabled unless PROXY_HMAC_KEY is valid.
	// PROXY_CACHE_DIR optionally keeps the fetched images on disk, and with it
	// the proxy can preload images in the background (see bin/pkg/prewarm).
	imgProxy := imgproxy.New(imgproxy.Config{
		HMACKey:            config.GlobalEnv.ProxyHMACKey,
		AllowedHosts:       config.GlobalEnv.ProxyAllowedHosts,
		PublicURL:          config.GlobalEnv.ProxyPublicURL,
		CacheDir:           config.GlobalEnv.ProxyCacheDir,
		CacheMaxBytes:      int64(config.GlobalEnv.ProxyCacheMaxMB) << 20,
		PrewarmConcurrency: config.GlobalEnv.ProxyPrewarmConcurrency,
	})
	imgProxy.Mount(e)

	// Remembers which chapters were prewarmed lately: shared by the chapter
	// handler (on demand) and the scheduler.
	recent := prewarm.NewRecent(recentChapters)

	comicHttp := mangaH.New(imgProxy)
	comicHttp.Mount(e)

	chapterHttp := chapterH.New(imgProxy, recent)
	chapterHttp.Mount(e)

	e.GET("/", func(c echo.Context) error {
		return utils.Response(map[string]string{"api-collection": "https://www.getpostman.com/collections/4c984c36d27bb591c445"}, "Get Collection", http.StatusOK, c)
	})

	// SIGINT and SIGTERM stop the server gracefully and the prewarm workers with it.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var background sync.WaitGroup
	startPrewarm(ctx, &background, imgProxy, recent)

	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := e.Shutdown(sctx); err != nil {
			e.Logger.Error(err)
		}
	}()

	listenerPort := fmt.Sprintf(":%d", config.GlobalEnv.HTTPPort)
	if err := e.Start(listenerPort); err != nil && !errors.Is(err, http.ErrServerClosed) {
		e.Logger.Fatal(err)
	}
	background.Wait()
}

// startPrewarm starts the image prewarm workers and, when PROXY_PREWARM_INTERVAL
// allows it, the scheduler that preloads the latest chapter of the newest and
// popular titles. Both end when ctx is cancelled and are joined through
// background. Prewarming needs the image proxy and its disk cache; without them
// this only logs that it is off.
func startPrewarm(ctx context.Context, background *sync.WaitGroup, imgProxy *imgproxy.Proxy, recent *prewarm.Recent) {
	if !imgProxy.PrewarmEnabled() {
		log.Println("prewarm: off (it needs PROXY_HMAC_KEY, PROXY_CACHE_DIR and PROXY_PREWARM_CONCURRENCY above 0)")
		return
	}
	imgProxy.Start(ctx)
	background.Add(1)
	go func() {
		defer background.Done()
		imgProxy.Wait()
	}()

	interval := config.GlobalEnv.ProxyPrewarmInterval
	maxChapters := config.GlobalEnv.ProxyPrewarmMaxChapters
	if interval <= 0 || maxChapters <= 0 {
		log.Println("prewarm: on for the chapters readers open, the schedule is off")
		return
	}
	log.Printf("prewarm: on, scheduled every %s for up to %d chapters per cycle", interval, maxChapters)

	// The scheduler scrapes on its own collector, a template like the handlers'.
	collector := colly.NewCollector()
	scheduler := &prewarm.Scheduler{
		Source: scraperSource{
			manga:   mangaQ.NewMangaQuery(config.GlobalEnv.BaseURL, collector),
			chapter: chapterQ.NewChapterQuery(config.GlobalEnv.BaseURL, collector),
		},
		Out:         imgProxy,
		Recent:      recent,
		Interval:    interval,
		StartDelay:  scheduleStartDelay,
		MaxChapters: maxChapters,
		Skip:        scheduleSkip,
		Pause:       schedulePause,
	}
	background.Add(1)
	go func() {
		defer background.Done()
		scheduler.Run(ctx)
	}()
}
