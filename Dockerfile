FROM nginx:stable-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html regions.json regions.geo.json /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY config/ /usr/share/nginx/html/config/
COPY map/index.html /usr/share/nginx/html/map/index.html
COPY map/public/ /usr/share/nginx/html/map/public/
COPY map/src/ /usr/share/nginx/html/map/src/
COPY shared/ /usr/share/nginx/html/shared/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
