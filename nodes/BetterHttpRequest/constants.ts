export const MAX_CONCURRENT_REQUESTS = 10;
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY = 1000; // milliseconds
export const DEFAULT_RETRY_ON_STATUS_CODES = '429,500,502,503,504';
export const RETRYABLE_CONNECTION_ERRORS = [
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'ENOTFOUND',
] as const;

export const FULL_RESPONSE_PROPERTIES = [
	'body',
	'headers',
	'statusCode',
	'statusMessage',
] as const;

export const ACCEPT_HEADERS = {
JSON: 'application/json,text/*;q=0.99',
TEXT: 'application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, */*;q=0.1',
AUTO: 'application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7',
} as const;

export const UI_MESSAGES = {
RATE_LIMITED_HINT: "Try spacing your requests out using the batching settings under 'Options'",
SPLIT_OUT_HINT: "To split the contents of 'data' into separate items for easier processing, add a 'Split Out' node after this one",
} as const;
