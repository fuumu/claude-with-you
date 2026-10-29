FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src/ src/
RUN npx tsc
# HTML ページ（admin.html ほか）と新規環境用の CoreMem スケルトン
COPY public/ public/
COPY skeleton/ skeleton/
EXPOSE 5002
CMD ["node", "dist/index.js"]
