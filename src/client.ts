// A small client for OpenAI-compatible chat completion servers (llama-server,
// vLLM, LM Studio, ...). It only ever talks to the configured base URL.

export type ToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

export type ChatMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

export type ToolSchema = {
	type: 'function';
	function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type Usage = { prompt_tokens: number; completion_tokens: number };

export type StreamResult = {
	content: string;
	reasoning: string;
	toolCalls: ToolCall[];
	usage?: Usage;
	finishReason?: string;
};

export type StreamHandlers = {
	onContent?: (delta: string) => void;
	onReasoning?: (delta: string) => void;
};

export type ClientOptions = { baseUrl: string; apiKey?: string };

export class ModelError extends Error {
	/** True when the server couldn't be reached or the connection broke, so another host might work. */
	readonly unreachable: boolean;

	constructor(message: string, options: { unreachable?: boolean } = {}) {
		super(message);
		this.unreachable = Boolean(options.unreachable);
	}
}

function headers(apiKey?: string): Record<string, string> {
	const h: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
	return h;
}

async function request(url: string, init: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		if ((error as Error).name === 'AbortError') throw error;
		const cause = (error as { cause?: { code?: string } }).cause?.code;
		throw new ModelError(`can't reach the model server at ${url}${cause ? ` (${cause})` : ''}`, { unreachable: true });
	}
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new ModelError(`model server returned ${response.status}: ${body.slice(0, 500)}`);
	}
	return response;
}

/** Split a byte stream into the `data:` payloads of server-sent events. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let index: number;
		while ((index = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, '');
			buffer = buffer.slice(index + 1);
			if (line.startsWith('data:')) yield line.slice(5).trimStart();
		}
	}
	const rest = buffer.trim();
	if (rest.startsWith('data:')) yield rest.slice(5).trimStart();
}

type Delta = {
	content?: string | null;
	reasoning_content?: string | null;
	tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

/** Fold streamed chunks into one result. Exported for tests. */
export class StreamAccumulator {
	content = '';
	reasoning = '';
	usage?: Usage;
	finishReason?: string;
	private calls = new Map<number, ToolCall>();

	constructor(private handlers: StreamHandlers = {}) {}

	add(chunk: { choices?: { delta?: Delta; finish_reason?: string | null }[]; usage?: Usage }): void {
		if (chunk.usage) this.usage = chunk.usage;
		const choice = chunk.choices?.[0];
		if (!choice) return;
		if (choice.finish_reason) this.finishReason = choice.finish_reason;
		const delta = choice.delta;
		if (!delta) return;
		if (delta.reasoning_content) {
			this.reasoning += delta.reasoning_content;
			this.handlers.onReasoning?.(delta.reasoning_content);
		}
		if (delta.content) {
			this.content += delta.content;
			this.handlers.onContent?.(delta.content);
		}
		for (const part of delta.tool_calls ?? []) {
			const index = part.index ?? this.calls.size;
			let call = this.calls.get(index);
			if (!call) {
				call = { id: '', type: 'function', function: { name: '', arguments: '' } };
				this.calls.set(index, call);
			}
			if (part.id) call.id = part.id;
			if (part.function?.name) call.function.name += part.function.name;
			if (part.function?.arguments) call.function.arguments += part.function.arguments;
		}
	}

	result(): StreamResult {
		const toolCalls = [...this.calls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([index, call]) => ({ ...call, id: call.id || `call_${Date.now()}_${index}` }));
		return {
			content: this.content,
			reasoning: this.reasoning,
			toolCalls,
			usage: this.usage,
			finishReason: this.finishReason,
		};
	}
}

export async function streamChat(
	options: ClientOptions & {
		model: string;
		messages: ChatMessage[];
		tools: ToolSchema[];
		signal?: AbortSignal;
	} & StreamHandlers,
): Promise<StreamResult> {
	const response = await request(`${options.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: headers(options.apiKey),
		signal: options.signal,
		body: JSON.stringify({
			model: options.model,
			messages: options.messages,
			tools: options.tools.length ? options.tools : undefined,
			stream: true,
			stream_options: { include_usage: true },
		}),
	});
	if (!response.body) throw new ModelError('model server sent an empty response');

	const acc = new StreamAccumulator(options);
	try {
		for await (const data of sseData(response.body)) {
			if (data === '[DONE]') break;
			let chunk;
			try {
				chunk = JSON.parse(data);
			} catch {
				continue;
			}
			if (chunk.error) throw new ModelError(`model server error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
			acc.add(chunk);
		}
	} catch (error) {
		if (error instanceof ModelError || (error as Error).name === 'AbortError' || options.signal?.aborted) throw error;
		// The connection dropped in the middle of the reply (server stopped, network gone).
		throw new ModelError(`lost the connection to the model server (${(error as Error).message})`, { unreachable: true });
	}
	return acc.result();
}

export async function listModels(options: ClientOptions & { signal?: AbortSignal }): Promise<string[]> {
	const response = await request(`${options.baseUrl}/models`, { headers: headers(options.apiKey), signal: options.signal });
	const json = (await response.json()) as { data?: { id: string }[] };
	return (json.data ?? []).map((m) => m.id);
}
