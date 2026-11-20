FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "src/index.js"]
