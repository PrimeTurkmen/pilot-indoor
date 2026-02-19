FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

ENV MQTT_BROKER=mqtt://localhost:1883
ENV PILOT_API_URL=https://your-server.pilot-gps.com
ENV PILOT_API_KEY=

CMD ["node", "server.js"]
