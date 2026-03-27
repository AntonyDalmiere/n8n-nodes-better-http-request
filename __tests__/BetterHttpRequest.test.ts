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
});
