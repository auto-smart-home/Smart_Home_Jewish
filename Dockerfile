FROM ghcr.io/home-assistant/amd64-base:3.19

# התקן Node.js
RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package.json ./
RUN npm install --production --quiet

COPY index.js ./
COPY smart_home_v3.html ./
COPY calendar_data.js ./

RUN mkdir -p /app/data

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
