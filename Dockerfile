FROM golang:1.24-alpine

LABEL maintainer="Romi666"

WORKDIR /usr/src/app

COPY . .

RUN go mod download \
  && go build -tags musl -o main ./bin/app

# Expose port
EXPOSE 8080

# Image proxy disk cache: Dokploy mounts a persistent volume here; set PROXY_CACHE_DIR empty to disable.
RUN mkdir -p /data/imgcache
ENV PROXY_CACHE_DIR=/data/imgcache

# Run application
CMD ["./main"]
