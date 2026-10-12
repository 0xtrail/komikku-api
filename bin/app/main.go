package main

import (
	"fmt"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"komikku-api/bin/config"
	chapterH "komikku-api/bin/modules/chapter/handlers"
	mangaH "komikku-api/bin/modules/manga/handlers"
	"komikku-api/bin/pkg/imgproxy"
	"komikku-api/bin/pkg/middlewares"
	"komikku-api/bin/pkg/utils"
	"net/http"
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
	imgProxy := imgproxy.New(imgproxy.Config{
		HMACKey:      config.GlobalEnv.ProxyHMACKey,
		AllowedHosts: config.GlobalEnv.ProxyAllowedHosts,
		PublicURL:    config.GlobalEnv.ProxyPublicURL,
	})
	imgProxy.Mount(e)

	comicHttp := mangaH.New(imgProxy)
	comicHttp.Mount(e)

	chapterHttp := chapterH.New(imgProxy)
	chapterHttp.Mount(e)

	e.GET("/", func(c echo.Context) error {
		return utils.Response(map[string]string{"api-collection": "https://www.getpostman.com/collections/4c984c36d27bb591c445"}, "Get Collection", http.StatusOK, c)
	})

	listenerPort := fmt.Sprintf(":%d", config.GlobalEnv.HTTPPort)
	e.Logger.Fatal(e.Start(listenerPort))
}
