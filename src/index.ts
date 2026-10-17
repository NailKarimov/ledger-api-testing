export * from './fixtures';
export { env } from '../config/env';
export { expectSchema } from './support/schema';

// OpenWeather
export { LOCATIONS, VALID_COORDS, INVALID_COORDS } from './openweather/locations';
export * from './openweather/schemas';
export type { Units, Coords } from './openweather/WeatherClient';

// Swagger Petstore
export * from './petstore/schemas';
export { newPet, uniqueId } from './petstore/data';

// GraphQL (Rick and Morty)
export * from './graphql/schemas';
export { nestedQuery } from './graphql/GraphQLClient';
export type { GraphQLResponse, GraphQLError } from './graphql/GraphQLClient';

// Sock Shop microservices
export * from './sockshop/schemas';
export type { Checkout } from './sockshop/SockShopClient';
export type { ShippingTask } from './sockshop/queue';
