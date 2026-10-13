# Build stage: dev dependencies and the TypeScript compiler stay out of the
# image that actually runs.
FROM node:22-alpine AS build

WORKDIR /usr/src/clinic-api

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

FROM node:22-alpine AS runtime

RUN mkdir -p /usr/src/clinic-api && chown -R node:node /usr/src/clinic-api
WORKDIR /usr/src/clinic-api

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=build /usr/src/clinic-api/dist ./dist
# The OpenAPI components are read from disk at runtime.
COPY src/docs ./src/docs

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
