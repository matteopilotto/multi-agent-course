import Anthropic from "@anthropic-ai/sdk";
import type { Response } from "express";
import type { TraceEvent } from "@lumina/contract";
import { env, secrets } from "./env.js";
import { TOOL_SCHEMAS, webSearch, fetchPage } from "./tools.js";
import { send } from "./sse.js";

const client = new Anthropic({ apiKey: secrets.anthropic });

const SYSTEM = `You are LUMINA, a web search assistant that answers with citations.

Procedure, every time:
1. Call web_search once or twice with focused queries.
2. Call fetch_page on the 2 to 4 most relevant results. You may only use facts from pages you have fetched. Search snippets are for choosing what to fetch, never for answering.
3. Write a concise answer (3 to 6 sentences) from the fetched text.

If fetching fails for every page, say that you could not read any source and stop.`;

/** TOOL_FUNCTIONS from agent_loop.py, as a switch. Stays local; the model never sees it. */
async function dispatch(
    name: string,
    input: Record<string, unknown>,
): Promise<string> {
    switch (name) {
        case "web_search":
            return JSON.stringify(await webSearch(String(input.query)));
        case "fetch_page":
            return fetchPage(String(input.url));
        default:
            throw new Error(`unknown tool ${name}`);
    }
}

export async function runQuickLoop(
    query: string,
    res: Response,
): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
        { role: "user", content: query },
    ];
    let step = 0;
    let response: Anthropic.Message;

    while (true) {
        response = await client.messages.create({
            model: env.llmModel,
            max_tokens: 1024,
            system: SYSTEM,
            tools: TOOL_SCHEMAS,
            messages,
        });
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            step += 1;
            const input = block.input as Record<string, unknown>;
            const t0 = Date.now();
            let output: string;
            let error: string | undefined;
            try {
                output = await dispatch(block.name, input);
            } catch (e) {
                error = e instanceof Error ? e.message : String(e);
                output = `ERROR: ${error}`;
            }
            const trace: TraceEvent = {
                step,
                tool: block.name as TraceEvent["tool"],
                input,
                ok: !error,
                ms: Date.now() - t0,
                ...(error ? { error } : {}),
            };
            send(res, "trace", trace);
            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
                is_error: !!error,
            });
        }
        messages.push({ role: "user", content: results });
    }

    return response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
}
