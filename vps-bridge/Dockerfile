FROM node:22-alpine

# Alpine's base image ships no git at all — easy to forget since the VPS
# HOST already has git 2.43.0, but the container doesn't inherit it.
RUN apk add --no-cache git

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN addgroup -S bridge && adduser -S bridge -G bridge \
  && mkdir -p /sandboxes && chown bridge:bridge /sandboxes

USER bridge

ENV SANDBOX_ROOT=/sandboxes
ENV PORT=3100

EXPOSE 3100

CMD ["node", "src/server.js"]
