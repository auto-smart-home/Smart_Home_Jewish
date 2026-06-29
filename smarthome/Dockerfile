FROM ghcr.io/home-assistant/amd64-base:3.19

RUN apk add --no-cache nodejs npm jq

WORKDIR /app

COPY package.json ./
RUN npm install --production --quiet

# ARG CACHEBUST מאלץ Docker לא להשתמש ב-cache מכאן והלאה
ARG CACHEBUST=1
COPY index.js ./
COPY smart_home_v3.html ./
COPY calendar_data.js ./

RUN mkdir -p /app/data

COPY run.sh /run.sh
RUN chmod a+x /run.sh

ENTRYPOINT ["/run.sh"]
