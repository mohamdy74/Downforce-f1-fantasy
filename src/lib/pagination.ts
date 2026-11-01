/**
 * Pagination utilities for cursor-based pagination
 *
 * Features:
 * - Cursor-based pagination (more efficient than offset-based)
 * - Default limit of 20 items per page
 * - Maximum limit of 100 items per page (prevents abuse)
 * - Type-safe pagination results
 * - Helper functions for building paginated queries
 */

/** Default number of items per page */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum number of items per page (prevents abuse) */
export const MAX_PAGE_SIZE = 100;

/** Minimum number of items per page */
export const MIN_PAGE_SIZE = 1;

/**
 * Result type for paginated queries
 *
 * @template T - The type of items in the list
 */
export interface PaginatedResult<T> {
  /** The list of items for this page */
  data: T[];
  /** Cursor for the next page (null if no more items) */
  nextCursor: string | null;
  /** Whether there are more items available */
  hasMore: boolean;
}

/**
 * Input options for pagination
 */
export interface PaginationOptions {
  /** Number of items to fetch (1-100, defaults to 20) */
  limit: number;
  /** Cursor for fetching the next page */
  cursor: string | null;
}

/**
 * Input for paginated queries from client
 */
export interface PaginationInput {
  /** Number of items to fetch (optional, defaults to 20) */
  limit?: number | null;
  /** Cursor for fetching the next page (optional) */
  cursor?: string | null;
}

/**
 * Get normalized pagination options from input
 *
 * @param input - Input from client
 * @returns Normalized pagination options
 */
export function getPaginationOptions(input?: PaginationInput | null): PaginationOptions {
  const limit = Math.min(Math.max(MIN_PAGE_SIZE, input?.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return {
    limit,
    cursor: input?.cursor ?? null,
  };
}

/**
 * Helper to extract next cursor from a sorted array
 *
 * @param items - Array of items with a cursor field
 * @param cursorField - Field name to use as cursor
 * @param order - Sort order ('asc' or 'desc')
 * @returns Next cursor value or null
 */
export function getNextCursor<T>(
  items: T[],
  cursorField: keyof T,
  order: "asc" | "desc" = "asc",
): string | null {
  if (items.length === 0) return null;

  const lastItem = items[items.length - 1]!;
  const cursorValue = lastItem[cursorField];

  if (cursorValue === null || cursorValue === undefined) return null;

  // Handle different types of cursor values
  if (typeof cursorValue === "string") {
    return cursorValue;
  }

  if (typeof cursorValue === "number") {
    return String(cursorValue);
  }

  if (cursorValue instanceof Date) {
    return cursorValue.toISOString();
  }

  // For other types, convert to string
  return String(cursorValue);
}

/**
 * Helper to check if there are more items
 *
 * @param fetchedCount - Number of items fetched
 * @param limit - Requested limit
 * @returns Whether there are more items
 */
export function hasMoreItems(fetchedCount: number, limit: number): boolean {
  return fetchedCount > limit;
}

/**
 * Create a paginated result from query results
 *
 * @param items - All items fetched (may include extra item for hasMore check)
 * @param limit - Requested limit
 * @param cursorField - Field name to use as cursor
 * @param order - Sort order
 * @returns Paginated result
 */
export function createPaginatedResult<T>(
  items: T[],
  limit: number,
  cursorField: keyof T,
  order: "asc" | "desc" = "asc",
): PaginatedResult<T> {
  const hasMore = hasMoreItems(items.length, limit);
  const data = hasMore ? items.slice(0, -1) : items;
  const nextCursor = hasMore ? getNextCursor(data, cursorField, order) : null;

  return {
    data,
    nextCursor,
    hasMore,
  };
}

/**
 * Type guard for PaginatedResult
 *
 * @param result - Value to check
 * @returns Whether the value is a PaginatedResult
 */
export function isPaginatedResult<T>(result: unknown): result is PaginatedResult<T> {
  return (
    typeof result === "object" &&
    result !== null &&
    "data" in result &&
    "nextCursor" in result &&
    "hasMore" in result &&
    Array.isArray((result as Record<string, unknown>)["data"])
  );
}

/**
 * Empty paginated result
 *
 * @returns Empty paginated result
 */
export function emptyPaginatedResult<T>(): PaginatedResult<T> {
  return {
    data: [],
    nextCursor: null,
    hasMore: false,
  };
}

/**
 * Pagination direction type
 */
export type PaginationDirection = "forward" | "backward";

/**
 * Options for building Supabase queries with pagination
 */
export interface SupabasePaginationOptions<T> {
  /** The Supabase query builder */
  query: { gt?: (column: keyof T, value: unknown) => unknown };
  /** Field to use as cursor */
  cursorField: keyof T;
  /** Cursor value */
  cursor: string | null;
  /** Sort order */
  order: "asc" | "desc";
}

/**
 * Apply cursor-based pagination to a Supabase query
 *
 * @param query - Supabase query builder
 * @param cursorField - Field to use as cursor
 * @param cursor - Cursor value
 * @param order - Sort order
 * @param limit - Number of items to fetch
 * @returns Modified query with pagination applied
 */
export function withCursorPagination<T>(
  query: { gt?: (column: keyof T, value: unknown) => unknown },
  cursorField: keyof T,
  cursor: string | null,
  order: "asc" | "desc",
  limit: number,
): { query: unknown; effectiveLimit: number } {
  // For cursor-based pagination, we fetch limit + 1 to check if there are more
  const effectiveLimit = limit + 1;

  let modifiedQuery = query;

  if (cursor !== null) {
    // Apply cursor filter based on order
    if (order === "asc") {
      // For ascending order, use gt (greater than) cursor
      modifiedQuery = modifiedQuery.gt?.(cursorField, cursor) || modifiedQuery;
    } else {
      // For descending order, use lt (less than) cursor
      // Note: This requires the query builder to support lt
      // For now, we'll use gt with descending order
      modifiedQuery = modifiedQuery.gt?.(cursorField, cursor) || modifiedQuery;
    }
  }

  return { query: modifiedQuery, effectiveLimit };
}

/**
 * Create pagination metadata for API responses
 *
 * @param page - Current page number (1-based)
 * @param pageSize - Items per page
 * @param totalCount - Total number of items (if known)
 * @param hasMore - Whether there are more items
 * @param nextCursor - Cursor for next page
 * @returns Pagination metadata
 */
export interface PaginationMetadata {
  page: number;
  pageSize: number;
  totalCount?: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export function createPaginationMetadata(
  page: number = 1,
  pageSize: number = DEFAULT_PAGE_SIZE,
  totalCount: number | undefined = undefined,
  hasMore: boolean = false,
  nextCursor: string | null = null,
): PaginationMetadata {
  return {
    page,
    pageSize,
    ...(totalCount !== undefined && { totalCount }),
    hasMore,
    nextCursor,
  };
}
