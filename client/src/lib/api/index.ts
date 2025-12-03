/**
 * API Module
 * 
 * Central export point for all API-related functionality.
 */

export { 
  api, 
  apiRequest, 
  unwrapResult, 
  createQueryFn,
  isApiError,
  ApiError,
} from './client';
export type { ApiErrorInfo, ApiResult } from './client';
export * from './types';
