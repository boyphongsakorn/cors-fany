#Use and existing docker image as a base
FROM node:alpine
WORKDIR '/app'
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm","run","dev"]