import Anthropic from "@anthropic-ai/sdk";
import type { Response } from "express";
import type { RunLog, Terminated, TraceEvent } from "@lumina/contract";
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

const CAP_NOTE =
    "Tool budget exhausted. Answer now with what you have, and say plainly what you could not verify.";

export type LoopResult = {
    text: string;
    terminated: Terminated;
    toolCalls: RunLog["toolCalls"];
};

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
): Promise<LoopResult> {
    const messages: Anthropic.MessageParam[] = [
        { role: "user", content: query },
    ];
    const toolCalls: RunLog["toolCalls"] = [];
    const deadline = Date.now() + env.maxWallClockSec * 1000;
    let step = 0;
    let terminated: Terminated = "done";
    let response: Anthropic.Message;

    const overCap = () =>
        step >= env.maxToolCalls || Date.now() > deadline;

    while (true) {
        const capped = overCap();
        response = await client.messages.create({
            model: env.llmModel,
            max_tokens: 1024,
            system: SYSTEM,
            tools: TOOL_SCHEMAS,
            messages,
            ...(capped ? { tool_choice: { type: "none" } } : {}),
        });
        messages.push({ role: "assistant", content: response.content });
        if (capped) {
            terminated = "cap";
            break;
        }
        if (response.stop_reason !== "tool_use") break;

        const results: Anthropic.ContentBlockParam[] = [];
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
            const ms = Date.now() - t0;
            const trace: TraceEvent = {
                step,
                tool: block.name as TraceEvent["tool"],
                input,
                ok: !error,
                ms,
                ...(error ? { error } : {}),
            };
            send(res, "trace", trace);
            toolCalls.push({
                name: trace.tool,
                ok: !error,
                ms,
                ...(error ? { error } : {}),
            });
            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
                is_error: !!error,
            });
        }
        if (overCap()) results.push({ type: "text", text: CAP_NOTE });
        messages.push({ role: "user", content: results });
    }

    const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    return { text, terminated, toolCalls };
}
