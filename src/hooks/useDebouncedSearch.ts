import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Reusable hook for debounced search/filter inputs with AbortController support.
 * 
 * Features:
 * - Debounces the search function by specified delay (default: 300ms)
 * - Cancels previous in-flight requests when new search starts
 * - Only searches when query has at least minLength characters (default: 2)
 * - Tracks loading state
 * - Returns debounced value for display
 * 
 * @param searchFn - Async function to execute when debounced
 * @param delay - Debounce delay in milliseconds (default: 300)
 * @param minLength - Minimum query length to trigger search (default: 2)
 * @returns Object with debounced value, loading state, and handlers
 */
export function useDebouncedSearch<T = unknown>(
  searchFn: (query: string, signal: AbortSignal) => Promise<T>,
  delay: number = 300,
  minLength: number = 2,
) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<T | null>(null);
  
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Clear any pending timeout and abort controller on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Debounce the query and execute search
  useEffect(() => {
    // Clear previous timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Don't search if query is too short
    if (query.length < minLength && query.length > 0) {
      setDebouncedQuery(query);
      setResult(null);
      setError(null);
      return;
    }

    // Set timeout for debounce
    timeoutRef.current = setTimeout(() => {
      setDebouncedQuery(query);
      
      // Only execute search if query meets minimum length
      if (query.length >= minLength || query.length === 0) {
        executeSearch(query);
      }
    }, delay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [query, delay, minLength, searchFn]);

  const executeSearch = useCallback(async (searchQuery: string) => {
    // Abort any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      setLoading(true);
      setError(null);
      
      if (searchQuery.length >= minLength || searchQuery.length === 0) {
        const result = await searchFn(searchQuery, controller.signal);
        setResult(result);
      } else {
        setResult(null);
      }
    } catch (err) {
      // Only set error if it's not an abort error
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err);
      }
    } finally {
      setLoading(false);
      // Clear the abort controller for this request
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [searchFn, minLength]);

  // Immediate setter for the query (doesn't trigger search)
  const setQueryImmediate = useCallback((value: string) => {
    setQuery(value);
  }, []);

  // Reset function
  const reset = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    setLoading(false);
    setError(null);
    setResult(null);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  return {
    // Current input value (updates immediately)
    query,
    // Debounced value (updates after delay)
    debouncedQuery,
    // Set the query value
    setQuery: setQueryImmediate,
    // Loading state
    loading,
    // Error state
    error,
    // Search result
    result,
    // Whether query meets minimum length
    isValid: query.length >= minLength,
    // Reset the search
    reset,
    // Manually trigger search with current query
    search: () => executeSearch(query),
  };
}

/**
 * Simplified version for use with React Query's useQuery hook.
 * Returns a debounced value that can be used as a query key.
 * 
 * @param value - The input value to debounce
 * @param delay - Debounce delay in milliseconds (default: 300)
 * @param minLength - Minimum length to consider valid (default: 2)
 * @returns Debounced value and loading state
 */
export function useDebouncedValue(
  value: string,
  delay: number = 300,
  minLength: number = 2,
) {
  const [debouncedValue, setDebouncedValue] = useState(
    value.length >= minLength ? value : "",
  );
  const [loading, setLoading] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    setLoading(true);

    timeoutRef.current = setTimeout(() => {
      setDebouncedValue(value);
      setLoading(false);
    }, delay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [value, delay]);

  return {
    debouncedValue,
    loading,
    isValid: value.length >= minLength,
  };
}

/**
 * Hook for debounced input with AbortController for fetch requests.
 * Use this when you need to cancel in-flight fetch requests.
 * 
 * @param fetchFn - Function that returns a fetch promise
 * @param delay - Debounce delay in ms
 * @param minLength - Minimum query length
 * @returns Object with handlers and states
 */
export function useDebouncedFetch<T = unknown>(
  fetchFn: (query: string, signal: AbortSignal) => Promise<T>,
  delay: number = 300,
  minLength: number = 2,
) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    if (query.length < minLength && query.length > 0) {
      setData(null);
      setError(null);
      return;
    }

    timeoutRef.current = setTimeout(() => {
      if (query.length >= minLength || query.length === 0) {
        fetchData(query);
      }
    }, delay);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [query, delay, minLength, fetchFn]);

  const fetchData = useCallback(async (searchQuery: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      setLoading(true);
      setError(null);
      const result = await fetchFn(searchQuery, controller.signal);
      setData(result);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err);
      }
    } finally {
      setLoading(false);
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [fetchFn]);

  return {
    query,
    setQuery,
    data,
    loading,
    error,
    isValid: query.length >= minLength,
    reset: () => {
      setQuery("");
      setData(null);
      setError(null);
      setLoading(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    },
  };
}
