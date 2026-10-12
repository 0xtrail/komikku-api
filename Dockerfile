FROM golang:1.24-alpine

LABEL maintainer="Romi666"

WORKDIR /usr/src/app

COPY . .

RUN go mod download \
  && go build -tags musl -o main ./bin/app

# Expose port
EXPOSE 8080

# Run application
CMD ["./main"]
