FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

# Velavu Cloud Engine (primary)
ENV VELAVU_API_TOKEN=
ENV VELAVU_API_URL=https://api.velavu.com
ENV VELAVU_POLL_MS=10000

# Channel Sounding Engine (secondary)
ENV MQTT_BROKER=mqtt://localhost:1883

# PILOT bridge
ENV PILOT_API_URL=https://your-server.pilot-gps.com
ENV PILOT_API_KEY=

EXPOSE 3080

CMD ["node", "server.js"]
