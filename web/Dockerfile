# Frontend build. PUBLIC_API_URL is read at build time by Astro, so it must be
# passed as an ARG: a static bundle has no runtime env.
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first so the dependency layer survives code-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG PUBLIC_API_URL=https://img2.kremlit.dev
ENV PUBLIC_API_URL=$PUBLIC_API_URL

RUN npm run build

# Serve the static output with nginx-unprivileged: uid 101, port 8080, which is
# what Dokploy expects.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]