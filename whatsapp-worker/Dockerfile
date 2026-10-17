FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.mjs ./

ENV WA_RUN_MINUTES=0
ENV WA_CREDS_DIR=/data/.wa-auth

CMD ["node", "index.mjs"]
