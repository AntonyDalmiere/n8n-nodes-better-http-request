import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	IRequestOptions,
} from 'n8n-workflow';
import { BetterHttpRequest } from '../nodes/BetterHttpRequest/BetterHttpRequest.node';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock IExecuteFunctions for testing the node's execute() method.
 *
 * `requestFn` simulates this.helpers.request(). It receives the IRequestOptions
 * and should return a response (or throw).
 */
function createMockExecuteFunctions(opts: {
	items: INodeExecutionData[];
	params?: Record<string, unknown>;
	continueOnFail?: boolean;
	requestFn?: (options: IRequestOptions) => Promise<unknown>;
	nodeVersion?: number;
}): IExecuteFunctions {
	const {
		items,
		params = {},
		continueOnFail = false,
		requestFn = async () => ({ body: {}, headers: { 'content-type': 'application/json' }, statusCode: 200, statusMessage: 'OK' }),
		nodeVersion = 1,
	} = opts;

	// Default parameter values — use 'json' responseFormat to skip autodetect/binary path
	const defaultParams: Record<string, unknown> = {
		'authentication': 'none',
		'url': 'https://example.com/api',
		'method': 'GET',
		'sendQuery': false,
		'specifyQuery': 'keypair',
		'jsonQuery': '',
		'sendBody': false,
		'contentType': '',
		'specifyBody': '',
		'bodyParameters.parameters': [],
		'jsonBody': '',
		'body': '',
		'sendHeaders': false,
		'specifyHeaders': 'keypair',
		'headerParameters.parameters': [],
		'jsonHeaders': '',
		'provideSslCertificates': false,
		'rawContentType': '',
		'inputDataFieldName': '',
		'options.pagination.pagination': null,
		'options.response.response.responseFormat': 'json',
		'options.response.response.fullResponse': false,
		'options.response.response.neverError': false,
		'options.response.response.outputPropertyName': 'data',
		'options.retryOnFail': false,
		'options.maxRetries': 3,
		'options.retryDelay': 1000,
		'options.retryOnStatusCodes': '429,500,502,503,504',
		...params,
	};

	// Ensure 'options' always contains the response sub-config (deep merge)
	const defaultResponseConfig = {
		response: {
			response: {
				responseFormat: 'json',
				fullResponse: false,
				neverError: false,
				outputPropertyName: 'data',
			},
		},
	};
	const userOptions = (defaultParams['options'] || {}) as Record<string, unknown>;
	defaultParams['options'] = { ...defaultResponseConfig, ...userOptions };
	// If user provided their own response config, keep it
	if (userOptions.response) {
		(defaultParams['options'] as Record<string, unknown>).response = userOptions.response;
	}

	const getNodeParameter = (name: string, itemIndex: number, defaultValue?: unknown, _opts?: unknown) => {
		// Check per-item params first (for multi-item tests)
		const perItemKey = `${name}[${itemIndex}]`;
		if (perItemKey in defaultParams) {
			return defaultParams[perItemKey];
		}
		if (name in defaultParams) {
			return defaultParams[name];
		}
		return defaultValue;
	};

	const mockNode = {
		name: 'BetterHttpRequest',
		typeVersion: nodeVersion,
		type: 'n8n-nodes-better-http-request.betterHttpRequest',
		parameters: {},
		position: [0, 0],
	};

	const mock = {
		getInputData: () => items,
		getNode: () => mockNode,
		getNodeParameter,
		getCredentials: jest.fn().mockResolvedValue({}),
		getCredentialsProperties: jest.fn().mockReturnValue([]),
		continueOnFail: () => continueOnFail,
		getMode: () => 'manual' as const,
		getContext: () => ({}),
		sendMessageToUI: jest.fn(),
		addExecutionHints: jest.fn(),
		logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
		helpers: {
			request: jest.fn().mockImplementation(requestFn),
			requestOAuth1: { call: jest.fn() },
			requestOAuth2: { call: jest.fn() },
			requestWithAuthentication: { call: jest.fn() },
			requestWithAuthenticationPaginated: { call: jest.fn() },
			assertBinaryData: jest.fn(),
			getBinaryStream: jest.fn(),
			getBinaryMetadata: jest.fn(),
			prepareBinaryData: jest.fn(),
			binaryToBuffer: jest.fn().mockImplementation(async (b: Buffer) => b),
			binaryToString: jest.fn().mockImplementation(async (b: Buffer, _enc?: string) => b.toString('utf-8')),
			detectBinaryEncoding: jest.fn().mockReturnValue('utf-8'),
		},
		isToolExecution: () => false,
	} as unknown as IExecuteFunctions;

	return mock;
}

function makeItems(count: number): INodeExecutionData[] {
	return Array.from({ length: count }, (_, i) => ({
		json: { index: i },
		pairedItem: { item: i },
	}));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BetterHttpRequest Node', () => {
	let node: BetterHttpRequest;

	beforeEach(() => {
		node = new BetterHttpRequest();
	});

	// 1. Basic GET request
	test('basic GET request returns response body', async () => {
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			requestFn: async () => ({
				body: { message: 'hello' },
				headers: { 'content-type': 'application/json' },
				statusCode: 200,
				statusMessage: 'OK',
			}),
		});

		const result = await node.execute.call(mockFn);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toEqual({ message: 'hello' });
	});

	// 2. POST with JSON body
	test('POST with JSON body sends body correctly', async () => {
		let capturedOptions: IRequestOptions | undefined;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: {
				method: 'POST',
				sendBody: true,
				contentType: 'json',
				specifyBody: 'json',
				jsonBody: '{"key":"value"}',
			},
			requestFn: async (opts) => {
				capturedOptions = opts;
				return {
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0][0].json).toEqual({ success: true });
		expect(capturedOptions?.body).toEqual({ key: 'value' });
		expect(capturedOptions?.method).toBe('POST');
	});

	// 3. Multiple items success
	test('multiple items all succeed', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(3),
			requestFn: async () => {
				callCount++;
				return {
					body: { item: callCount },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(3);
		expect(result[0][0].json).toEqual({ item: 1 });
		expect(result[0][1].json).toEqual({ item: 2 });
		expect(result[0][2].json).toEqual({ item: 3 });
	});

	// 3b. High-volume items success
	test('processes 5000 items successfully', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(5000),
			requestFn: async () => {
				const index = callCount;
				callCount++;
				return {
					body: { item: index },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(5000);
		expect(callCount).toBe(5000);
		expect(result[0][0].json).toEqual({ item: 0 });
		expect(result[0][4999].json).toEqual({ item: 4999 });
	}, 30000);

	// 3c. High-volume execution is bounded by internal concurrency cap
	test('limits in-flight requests under high load', async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		const mockFn = createMockExecuteFunctions({
			items: makeItems(200),
			requestFn: async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 2));
				inFlight--;
				return {
					body: { ok: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(200);
		expect(maxInFlight).toBeLessThanOrEqual(10);
	}, 30000);

	// 4. Continue on fail
	test('continue on fail returns error items', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(3),
			continueOnFail: true,
			requestFn: async () => {
				callCount++;
				if (callCount === 2) {
					const err: any = new Error('Server Error');
					err.statusCode = 500;
					throw err;
				}
				return {
					body: { ok: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(3);
		// Item 0: success
		expect(result[0][0].json).toEqual({ ok: true });
		// Item 1: error
		expect(result[0][1].json).toHaveProperty('error');
		// Item 2: success
		expect(result[0][2].json).toEqual({ ok: true });
	});

	// 5. Retry failed items - succeeds on retry
	test('retry failed items succeeds on second attempt', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(3),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 3,
					retryDelay: 0,
					retryOnStatusCodes: '429,500,502,503,504',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 3,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '429,500,502,503,504',
			},
			requestFn: async () => {
				callCount++;
				// Second call (item 1) fails on first pass, then succeeds on retry
				if (callCount === 2) {
					const err: any = new Error('Internal Server Error');
					err.statusCode = 500;
					throw err;
				}
				return {
					body: { success: true, call: callCount },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(3);
		// Items 0 and 2 succeed on first pass
		expect(result[0][0].json).toHaveProperty('success', true);
		expect(result[0][2].json).toHaveProperty('success', true);
		// Item 1 should have been retried and now succeed
		expect(result[0][1].json).not.toHaveProperty('error');
		expect(result[0][1].json).toHaveProperty('success', true);
	});

	// 5b. Retry concurrency should stay bounded under large failure sets
	test('retry execution is bounded by concurrency cap on large batches', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const attemptsByUri = new Map<string, number>();

		const itemCount = 60;
		const params: Record<string, unknown> = {
			'options': {
				retryOnFail: true,
				maxRetries: 1,
				retryDelay: 0,
				retryOnStatusCodes: '500',
			},
			'options.retryOnFail': true,
			'options.maxRetries': 1,
			'options.retryDelay': 0,
			'options.retryOnStatusCodes': '500',
		};

		for (let i = 0; i < itemCount; i++) {
			params[`url[${i}]`] = `https://api.example.com/retry/${i}`;
		}

		const mockFn = createMockExecuteFunctions({
			items: makeItems(itemCount),
			continueOnFail: true,
			params,
			requestFn: async (opts) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 3));

				const uri = String(opts.uri ?? '');
				const attempts = (attemptsByUri.get(uri) ?? 0) + 1;
				attemptsByUri.set(uri, attempts);

				inFlight--;
				if (attempts === 1) {
					const err: any = new Error('Internal Server Error');
					err.statusCode = 500;
					throw err;
				}

				return {
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);

		expect(result[0]).toHaveLength(itemCount);
		expect(result[0].every((item) => !item.json.error)).toBe(true);
		expect(maxInFlight).toBeLessThanOrEqual(10);
	}, 30000);

	// 6. Retry with 429 + Retry-After header
	test('retry respects 429 Retry-After header', async () => {
		let callCount = 0;
		const sleepCalls: number[] = [];
		// Monkey-patch sleep to track calls
		const origSleep = jest.requireActual('n8n-workflow').sleep;
		const sleepSpy = jest.spyOn(require('n8n-workflow'), 'sleep').mockImplementation(async (...args: unknown[]) => {
			sleepCalls.push(args[0] as number);
			// Don't actually sleep in tests
		});

		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 3,
					retryDelay: 100,
					retryOnStatusCodes: '429,500',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 3,
				'options.retryDelay': 100,
				'options.retryOnStatusCodes': '429,500',
			},
			requestFn: async () => {
				callCount++;
				if (callCount === 1) {
					const err: any = new Error('Too Many Requests');
					err.statusCode = 429;
					err.headers = { 'retry-after': '2' };
					throw err;
				}
				return {
					body: { retried: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('retried', true);
		// Sleep should have been called with 2000ms (from Retry-After: 2 seconds)
		const retryDelayCalls = sleepCalls.filter(ms => ms >= 100);
		expect(retryDelayCalls.length).toBeGreaterThan(0);
		expect(retryDelayCalls.some(ms => ms >= 2000)).toBe(true);

		sleepSpy.mockRestore();
	});

	// 7. Retry exhaustion
	test('retry exhaustion keeps error in output', async () => {
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 2,
					retryDelay: 0,
					retryOnStatusCodes: '500',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 2,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '500',
			},
			requestFn: async () => {
				const err: any = new Error('Server Error');
				err.statusCode = 500;
				throw err;
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		// Should still have error after all retries exhausted
		expect(result[0][0].json).toHaveProperty('error');
	});

	// 8. Retry only specific status codes (400 NOT retried, 500 IS retried)
	test('retry only retries specific status codes', async () => {
		let requestCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(2),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 2,
					retryDelay: 0,
					retryOnStatusCodes: '500,502',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 2,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '500,502',
			},
			requestFn: async () => {
				requestCount++;
				if (requestCount === 1) {
					// Item 0: 400 error - should NOT be retried
					const err: any = new Error('Bad Request');
					err.statusCode = 400;
					throw err;
				}
				if (requestCount === 2) {
					// Item 1: 500 error - should be retried
					const err: any = new Error('Internal Server Error');
					err.statusCode = 500;
					throw err;
				}
				// Retry of item 1 succeeds
				return {
					body: { fixed: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(2);
		// Item 0: 400 - stays as error (not retried)
		expect(result[0][0].json).toHaveProperty('error');
		// Item 1: 500 - retried and succeeded
		expect(result[0][1].json).toHaveProperty('fixed', true);
	});

	// 9. Custom headers
	test('custom headers are sent in request', async () => {
		let capturedOptions: IRequestOptions | undefined;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: {
				sendHeaders: true,
				specifyHeaders: 'keypair',
				'headerParameters.parameters': [
					{ name: 'X-Custom-Header', value: 'test-value' },
				],
			},
			requestFn: async (opts) => {
				capturedOptions = opts;
				return {
					body: { ok: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0][0].json).toEqual({ ok: true });
		// Headers should be lowercased by default
		expect(capturedOptions?.headers).toHaveProperty('x-custom-header', 'test-value');
	});

	// 10. Query parameters
	test('query parameters are sent in request', async () => {
		let capturedOptions: IRequestOptions | undefined;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: {
				sendQuery: true,
				specifyQuery: 'keypair',
				'queryParameters.parameters': [
					{ name: 'page', value: '1' },
					{ name: 'limit', value: '10' },
				],
			},
			requestFn: async (opts) => {
				capturedOptions = opts;
				return {
					body: { data: [] },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0][0].json).toEqual({ data: [] });
		expect(capturedOptions?.qs).toEqual({ page: '1', limit: '10' });
	});

	// 11. Full response mode
	test('full response mode returns headers, statusCode, statusMessage', async () => {
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: {
				'options': {
					response: {
						response: {
							fullResponse: true,
							responseFormat: 'json',
							neverError: false,
							outputPropertyName: 'data',
						},
					},
				},
				'options.response.response.responseFormat': 'json',
				'options.response.response.fullResponse': true,
				'options.response.response.neverError': false,
				'options.response.response.outputPropertyName': 'data',
			},
			requestFn: async () => ({
				body: { result: 'ok' },
				headers: { 'content-type': 'application/json', 'x-test': '1' },
				statusCode: 200,
				statusMessage: 'OK',
			}),
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		const item = result[0][0].json;
		expect(item).toHaveProperty('body');
		expect(item).toHaveProperty('headers');
		expect(item).toHaveProperty('statusCode', 200);
		expect(item).toHaveProperty('statusMessage', 'OK');
		expect((item as IDataObject).body).toEqual({ result: 'ok' });
	});

	// 12. Text response format
	test('text response format returns text in output field', async () => {
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: {
				'options': {
					response: {
						response: {
							fullResponse: false,
							responseFormat: 'text',
							neverError: false,
							outputPropertyName: 'data',
						},
					},
				},
				'options.response.response.responseFormat': 'text',
				'options.response.response.fullResponse': false,
				'options.response.response.neverError': false,
				'options.response.response.outputPropertyName': 'data',
			},
			requestFn: async () => ({
				body: 'Hello, World!',
				headers: { 'content-type': 'text/plain' },
				statusCode: 200,
				statusMessage: 'OK',
			}),
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('data', 'Hello, World!');
	});

	// 12b. Autodetect should not stream responses
	test('autodetect response format uses buffered body (no stream) and parses JSON', async () => {
		let capturedOptions: IRequestOptions | undefined;

		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: {
				'options': {
					response: {
						response: {
							fullResponse: false,
							responseFormat: 'autodetect',
							neverError: false,
							outputPropertyName: 'data',
						},
					},
				},
				'options.response.response.responseFormat': 'autodetect',
				'options.response.response.fullResponse': false,
				'options.response.response.neverError': false,
				'options.response.response.outputPropertyName': 'data',
			},
			requestFn: async (opts) => {
				capturedOptions = opts;
				return {
					body: Buffer.from('{"ok":true}'),
					headers: { 'content-type': 'application/json; charset=utf-8' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);

		expect(capturedOptions?.encoding).toBeNull();
		expect(capturedOptions?.json).toBe(false);
		expect(capturedOptions?.useStream).toBe(false);
		expect(result[0][0].json).toEqual({ ok: true });
	});

	// 13. Never error mode - non-2xx responses don't throw
	test('never error mode does not throw on non-2xx', async () => {
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: {
				'options': {
					response: {
						response: {
							neverError: true,
							responseFormat: 'json',
							fullResponse: false,
							outputPropertyName: 'data',
						},
					},
				},
				'options.response.response.responseFormat': 'json',
				'options.response.response.fullResponse': false,
				'options.response.response.neverError': true,
				'options.response.response.outputPropertyName': 'data',
			},
			requestFn: async () => ({
				body: { error: 'not found' },
				headers: { 'content-type': 'application/json' },
				statusCode: 404,
				statusMessage: 'Not Found',
			}),
		});

		// Should not throw
		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toEqual({ error: 'not found' });
	});

	// Additional: URL validation
	test('throws on invalid URL', async () => {
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			params: { url: 'not-a-url' },
		});

		await expect(node.execute.call(mockFn)).rejects.toThrow(/Invalid URL/);
	});

	// Additional: node description is correct
	test('node description has correct properties', () => {
		expect(node.description.displayName).toBe('Better HTTP Request');
		expect(node.description.name).toBe('betterHttpRequest');
		expect(node.description.version).toBe(1);
		expect(node.description.properties).toBeDefined();
		expect(node.description.properties.length).toBeGreaterThan(0);
	});

	// Additional: retry with retryOnFail disabled doesn't retry
	test('retry is not attempted when retryOnFail is false', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {},
				'options.retryOnFail': false,
			},
			requestFn: async () => {
				callCount++;
				const err: any = new Error('Server Error');
				err.statusCode = 500;
				throw err;
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('error');
		// Only 1 call - no retries
		expect(callCount).toBe(1);
	});

	// Connection Errors - ECONNREFUSED
	test('connection error ECONNREFUSED is retried on fail', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 3,
					retryDelay: 0,
					retryOnStatusCodes: '429,500,502,503,504',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 3,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '429,500,502,503,504',
			},
			requestFn: async () => {
				callCount++;
				if (callCount === 1) {
					const err: any = new Error('Connection refused');
					err.code = 'ECONNREFUSED';
					throw err;
				}
				return {
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		// Should succeed after retry
		expect(result[0][0].json).toHaveProperty('success', true);
		expect(result[0][0].json).not.toHaveProperty('error');
		// Should have been called twice (once failed, once succeeded)
		expect(callCount).toBe(2);
	});

	// Connection Errors - ECONNRESET
	test('connection error ECONNRESET is retried on fail', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 3,
					retryDelay: 0,
					retryOnStatusCodes: '429,500,502,503,504',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 3,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '429,500,502,503,504',
			},
			requestFn: async () => {
				callCount++;
				if (callCount === 1) {
					const err: any = new Error('Connection reset');
					err.code = 'ECONNRESET';
					throw err;
				}
				return {
					body: { fixed: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('fixed', true);
		expect(callCount).toBe(2);
	});

	// Connection Errors - ETIMEDOUT
	test('connection error ETIMEDOUT is retried on fail', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 3,
					retryDelay: 0,
					retryOnStatusCodes: '429,500,502,503,504',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 3,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '429,500,502,503,504',
			},
			requestFn: async () => {
				callCount++;
				if (callCount === 1) {
					const err: any = new Error('Connection timeout');
					err.code = 'ETIMEDOUT';
					throw err;
				}
				return {
					body: { recovered: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('recovered', true);
		expect(callCount).toBe(2);
	});

	// Connection Errors - ENOTFOUND
	test('connection error ENOTFOUND is retried on fail', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 3,
					retryDelay: 0,
					retryOnStatusCodes: '429,500,502,503,504',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 3,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '429,500,502,503,504',
			},
			requestFn: async () => {
				callCount++;
				if (callCount === 1) {
					const err: any = new Error('getaddrinfo ENOTFOUND example.com');
					err.code = 'ENOTFOUND';
					throw err;
				}
				return {
					body: { resolved: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('resolved', true);
		expect(callCount).toBe(2);
	});

	// Connection error exhaustion - still kept as error after max retries
	test('connection error exhaustion keeps error in output', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 2,
					retryDelay: 0,
					retryOnStatusCodes: '500',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 2,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '500',
			},
			requestFn: async () => {
				callCount++;
				const err: any = new Error('Connection refused');
				err.code = 'ECONNREFUSED';
				throw err;
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('error');
		// Should have been retried: 1 initial + 2 retries = 3 calls
		expect(callCount).toBe(3);
	});

	// Connection error not retried when retryOnFail disabled
	test('connection error is not retried when retryOnFail is false', async () => {
		let callCount = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(1),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: false,
				},
				'options.retryOnFail': false,
			},
			requestFn: async () => {
				callCount++;
				const err: any = new Error('Connection reset');
				err.code = 'ECONNRESET';
				throw err;
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toHaveProperty('error');
		// Only 1 call - no retries
		expect(callCount).toBe(1);
	});

	// Mixed: connection error and HTTP status code both retried
	test('connection errors and HTTP status codes are both retried', async () => {
		let itemIndex = 0;
		let callCountItem0 = 0;
		let callCountItem1 = 0;
		const mockFn = createMockExecuteFunctions({
			items: makeItems(2),
			continueOnFail: true,
			params: {
				'options': {
					retryOnFail: true,
					maxRetries: 2,
					retryDelay: 0,
					retryOnStatusCodes: '500',
				},
				'options.retryOnFail': true,
				'options.maxRetries': 2,
				'options.retryDelay': 0,
				'options.retryOnStatusCodes': '500',
			},
			requestFn: async (opts) => {
				itemIndex++;
				// Item 0: connection error
				if (itemIndex === 1) {
					callCountItem0++;
					if (callCountItem0 === 1) {
						const err: any = new Error('Connection refused');
						err.code = 'ECONNREFUSED';
						throw err;
					}
					return {
						body: { item: 0, success: true },
						headers: { 'content-type': 'application/json' },
						statusCode: 200,
						statusMessage: 'OK',
					};
				}
				// Item 1: HTTP 500 error
				if (itemIndex === 2) {
					callCountItem1++;
					if (callCountItem1 === 1) {
						const err: any = new Error('Server Error');
						err.statusCode = 500;
						throw err;
					}
					return {
						body: { item: 1, success: true },
						headers: { 'content-type': 'application/json' },
						statusCode: 200,
						statusMessage: 'OK',
					};
				}
				return {
					body: {},
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			},
		});

		const result = await node.execute.call(mockFn);
		expect(result[0]).toHaveLength(2);
		// Both items should succeed after retry
		expect(result[0][0].json).toHaveProperty('item', 0);
		expect(result[0][0].json).not.toHaveProperty('error');
		expect(result[0][1].json).toHaveProperty('item', 1);
		expect(result[0][1].json).not.toHaveProperty('error');
	});

	describe('Stress and Chaos Tests', () => {
		it('should handle a massive batch of 1000 items successfully', async () => {
			const mockFn = createMockExecuteFunctions({
				items: makeItems(1000),
				params: {
					method: 'GET',
					url: 'https://api.example.com/data',
					options: {},
				},
				requestFn: async () => ({
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				}),
			});

			const startTime = Date.now();
			const result = await node.execute.call(mockFn);
			const duration = Date.now() - startTime;

			expect(result[0]).toHaveLength(1000);
			expect(result[0][999].json).toHaveProperty('success', true);
			expect(duration).toBeLessThan(5000);
		});

		it('should handle a mixed massive batch with failures and continueOnFail', async () => {
			let callCount = 0;
			const chaoticRequestFn = async () => {
				callCount++;
				if (callCount % 10 === 0) {
					const error: any = new Error('ECONNRESET');
					error.code = 'ECONNRESET';
					throw error;
				}
				if (callCount % 15 === 0) {
					const error: any = new Error('Proxy Auth required');
					error.statusCode = 407;
					throw error;
				}
				if (callCount % 100 === 0) {
					await new Promise(r => setTimeout(r, 50)); // simulate hang, keep it short
					const error: any = new Error('ETIMEDOUT');
					error.code = 'ETIMEDOUT';
					throw error;
				}
				return {
					body: { success: true, count: callCount },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			};

			const mockFn = createMockExecuteFunctions({
				continueOnFail: true,
				items: makeItems(1000),
				params: {
					method: 'GET',
					url: 'https://api.example.com/data',
					options: {},
				},
				requestFn: chaoticRequestFn,
			});

			const result = await node.execute.call(mockFn);
			expect(result[0]).toHaveLength(1000); // Because continueOnFail is true

			const fails = result[0].filter(item => item.json.error);
			const successes = result[0].filter(item => item.json.success === true);

			expect(fails.length).toBeGreaterThan(0);
			expect(successes.length).toBeGreaterThan(800);
		});

		it('should handle rate limiting with retries on a large batch using sleep backoff', async () => {
			const sleepSpy = jest.spyOn(require('n8n-workflow'), 'sleep').mockImplementation(async () => {});
			let callIndex = 0;
			const requestFn = async () => {
				callIndex++;
				if (callIndex <= 2) {
					const err: any = new Error('Too Many Requests');
					err.statusCode = 429;
					throw err;
				}
				// Succeed on attempt 3
				return {
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				};
			};

			const mockFn = createMockExecuteFunctions({
				continueOnFail: true,
				items: makeItems(1), // test one item retrying multiple times to prove retry logic over large batch behavior is sane
				params: {
					method: 'GET',
					url: 'https://api.example.com/data',
					'options': {
						retryOnFail: true,
						maxRetries: 3,
						retryDelay: 10,
						retryOnStatusCodes: '429',
					},
					'options.retryOnFail': true,
					'options.maxRetries': 3,
					'options.retryDelay': 10,
					'options.retryOnStatusCodes': '429',
				},
				requestFn,
			});

			const result = await node.execute.call(mockFn);
			expect(result[0]).toHaveLength(1);
			expect(result[0][0].json).toHaveProperty('success', true);
			expect(sleepSpy).toHaveBeenCalledTimes(2); // Retried twice before succeeding
			expect(callIndex).toBe(3); // Attempted three times total
			sleepSpy.mockRestore();
		});
	});

	describe('Progress Tracking Regression Tests', () => {
		/**
		 * Regression test: Progress must reach 100% even when some items fail during build phase.
		 * Bug: Items that fail URL validation caused early returns in finally block,
		 * preventing completedCount from incrementing, leaving the node "in progress" forever.
		 */
		it('should report 100% progress when some items fail URL validation', async () => {
			const progressCalls: any[] = [];
			const sendMessageToUI = jest.fn((msg: any) => {
				if (msg.type === 'progress') {
					progressCalls.push(msg);
				}
			});

			const mockFn = createMockExecuteFunctions({
				items: [
					{ json: { index: 0 }, pairedItem: { item: 0 } }, // Valid URL
					{ json: { index: 1 }, pairedItem: { item: 1 } }, // Invalid URL
					{ json: { index: 2 }, pairedItem: { item: 2 } }, // Valid URL
				],
				continueOnFail: true,
				params: {
					// Per-item URLs - item 1 has invalid URL
					'url[0]': 'https://api.example.com/data',
					'url[1]': 'not-a-valid-url',
					'url[2]': 'https://api.example.com/data2',
				},
				requestFn: async () => ({
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				}),
			});

			// Override sendMessageToUI to capture progress
			(mockFn as any).sendMessageToUI = sendMessageToUI;

			const result = await node.execute.call(mockFn);

			// Should complete all 3 items
			expect(result[0]).toHaveLength(3);
			// Item 0 and 2 should succeed
			expect(result[0][0].json).toHaveProperty('success', true);
			expect(result[0][2].json).toHaveProperty('success', true);
			// Item 1 should have an error
			expect(result[0][1].json).toHaveProperty('error');

			// Progress must reach 100% - this is the critical assertion
			const lastProgress = progressCalls[progressCalls.length - 1];
			expect(lastProgress).toBeDefined();
			expect(lastProgress.percentage).toBe(100);
			expect(lastProgress.completed).toBe(3);
			expect(lastProgress.total).toBe(3);
		});

		it('should report 100% progress when all items fail during build phase', async () => {
			const progressCalls: any[] = [];
			const sendMessageToUI = jest.fn((msg: any) => {
				if (msg.type === 'progress') {
					progressCalls.push(msg);
				}
			});

			const mockFn = createMockExecuteFunctions({
				items: [
					{ json: { index: 0 }, pairedItem: { item: 0 } },
					{ json: { index: 1 }, pairedItem: { item: 1 } },
					{ json: { index: 2 }, pairedItem: { item: 2 } },
				],
				continueOnFail: true,
				params: {
					'url[0]': 'invalid-url-1',
					'url[1]': 'invalid-url-2',
					'url[2]': 'invalid-url-3',
				},
				requestFn: async () => ({
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				}),
			});

			(mockFn as any).sendMessageToUI = sendMessageToUI;

			const result = await node.execute.call(mockFn);

			// All items should have errors
			expect(result[0]).toHaveLength(3);
			expect(result[0][0].json).toHaveProperty('error');
			expect(result[0][1].json).toHaveProperty('error');
			expect(result[0][2].json).toHaveProperty('error');

			// Progress MUST reach 100% - critical regression check
			const lastProgress = progressCalls[progressCalls.length - 1];
			expect(lastProgress).toBeDefined();
			expect(lastProgress.percentage).toBe(100);
			expect(lastProgress.completed).toBe(3);
			expect(lastProgress.total).toBe(3);
		});

		it('should report 100% progress with mixed build failures and request failures', async () => {
			const progressCalls: any[] = [];
			const sendMessageToUI = jest.fn((msg: any) => {
				if (msg.type === 'progress') {
					progressCalls.push(msg);
				}
			});

			const mockFn = createMockExecuteFunctions({
				items: makeItems(5),
				continueOnFail: true,
				params: {
					// Items 1 and 3 have invalid URLs (build phase failure)
					'url[0]': 'https://api.example.com/data?item=0',
					'url[1]': 'not-valid',
					'url[2]': 'https://api.example.com/data?item=2',
					'url[3]': 'also-invalid',
					'url[4]': 'https://api.example.com/data?item=4',
				},
				requestFn: async (opts) => {
					const requestUri = String(opts.uri ?? '');
					// Make failure deterministic by item identity, not request execution order
					if (requestUri.includes('item=2')) {
						const err: any = new Error('Server Error');
						err.statusCode = 500;
						throw err;
					}
					return {
						body: { success: true },
						headers: { 'content-type': 'application/json' },
						statusCode: 200,
						statusMessage: 'OK',
					};
				},
			});

			(mockFn as any).sendMessageToUI = sendMessageToUI;

			const result = await node.execute.call(mockFn);

			expect(result[0]).toHaveLength(5);
			// Items 0 and 4 should succeed
			expect(result[0][0].json).toHaveProperty('success', true);
			expect(result[0][4].json).toHaveProperty('success', true);
			// Items 1 and 3 should have build errors
			expect(result[0][1].json).toHaveProperty('error');
			expect(result[0][3].json).toHaveProperty('error');
			// Item 2 should have request error
			expect(result[0][2].json).toHaveProperty('error');

			// Progress MUST reach 100% with all 5 items counted
			const lastProgress = progressCalls[progressCalls.length - 1];
			expect(lastProgress).toBeDefined();
			expect(lastProgress.percentage).toBe(100);
			expect(lastProgress.completed).toBe(5);
			expect(lastProgress.total).toBe(5);
		});

		it('should report 100% progress for large batch with scattered build failures', async () => {
			const progressCalls: any[] = [];
			const sendMessageToUI = jest.fn((msg: any) => {
				if (msg.type === 'progress') {
					progressCalls.push(msg);
				}
			});

			const itemCount = 100;
			const items = makeItems(itemCount);

			// Create params with scattered invalid URLs
			const params: Record<string, unknown> = {};
			for (let i = 0; i < itemCount; i++) {
				// Every 7th item has invalid URL
				if (i % 7 === 0) {
					params[`url[${i}]`] = 'invalid-url';
				} else {
					params[`url[${i}]`] = 'https://api.example.com/data';
				}
			}

			const mockFn = createMockExecuteFunctions({
				items,
				continueOnFail: true,
				params,
				requestFn: async () => ({
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				}),
			});

			(mockFn as any).sendMessageToUI = sendMessageToUI;

			const result = await node.execute.call(mockFn);

			expect(result[0]).toHaveLength(itemCount);

			// Progress MUST reach 100%
			const lastProgress = progressCalls[progressCalls.length - 1];
			expect(lastProgress).toBeDefined();
			expect(lastProgress.percentage).toBe(100);
			expect(lastProgress.completed).toBe(itemCount);
			expect(lastProgress.total).toBe(itemCount);
		}, 10000);

		it('should not report 100% before the final item in large batches', async () => {
			const progressCalls: any[] = [];
			const sendMessageToUI = jest.fn((msg: any) => {
				if (msg.type === 'progress') {
					progressCalls.push(msg);
				}
			});

			const itemCount = 200;
			const mockFn = createMockExecuteFunctions({
				items: makeItems(itemCount),
				continueOnFail: true,
				requestFn: async () => ({
					body: { success: true },
					headers: { 'content-type': 'application/json' },
					statusCode: 200,
					statusMessage: 'OK',
				}),
			});

			(mockFn as any).sendMessageToUI = sendMessageToUI;

			await node.execute.call(mockFn);

			const callsAtHundred = progressCalls.filter((call) => call.percentage === 100);
			expect(callsAtHundred.length).toBeGreaterThan(0);
			for (const call of callsAtHundred) {
				expect(call.completed).toBe(itemCount);
				expect(call.total).toBe(itemCount);
			}

			const preFinalCalls = progressCalls.filter((call) => call.completed < itemCount);
			expect(preFinalCalls.every((call) => call.percentage < 100)).toBe(true);
		}, 15000);
	});
});
