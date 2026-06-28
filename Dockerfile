ARG BUILD_FROM
FROM $BUILD_FROM

# התקן Node.js
RUN apk add --no-cache nodejs npm

WORKDIR /app

# התקן תלויות
COPY package.json ./
RUN npm install --production --quiet

# קבצי האפליקציה
COPY index.js ./
COPY smart_home_v3.html ./
COPY calendar_data.js ./

# תיקיית data — תוחלף ב-volume בזמן ריצה
RUN mkdir -p /app/data

# סקריפט הפעלה
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
