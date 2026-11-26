# LEADS without sign-in, for trying it on your own computer (see the main README).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_PUBLIC_LEADS_NO_SIGN_IN=1 NEXT_PUBLIC_LEADS_EVAL_REPORT=false NEXT_TELEMETRY_DISABLED=1
RUN npm run build && chown -R node:node .next
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["npm", "start"]
