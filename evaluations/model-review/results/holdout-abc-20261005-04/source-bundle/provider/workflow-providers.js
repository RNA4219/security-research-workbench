import { createHash } from "node:crypto";
import { DomainError } from "../shared/domain-error.js";
const numberSetting = (value) => {
    if (value === undefined || value.trim() === "")
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
function checkedEndpoint(kind, raw, allowedHosts) {
    if (!raw)
        return undefined;
    try {
        const url = new URL(raw);
        if (url.username || url.password || url.search || url.hash)
            return undefined;
        if (kind === "local") {
            const isLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
            if (!isLoopback ||
                (url.protocol !== "http:" && url.protocol !== "https:"))
                return undefined;
        }
        else if (url.protocol !== "https:" ||
            !allowedHosts.has(url.hostname.toLowerCase())) {
            return undefined;
        }
        const path = url.pathname.replace(/\/+$/, "") || "/";
        // /v1 is the default API prefix used by completionUrl. Store it in the
        // same canonical form as a bare endpoint so equivalent settings share an
        // identity while the request URL remains unchanged.
        url.pathname = path === "/v1" ? "/" : path;
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return undefined;
    }
}
function endpointConfigVersion(base, kind, endpoint) {
    const digest = createHash("sha256")
        .update(`${kind}\0${endpoint ?? "<missing>"}`, "utf8")
        .digest("hex");
    return `${base}:endpoint-${digest}`;
}
function completionUrl(endpoint) {
    return endpoint.endsWith("/v1")
        ? `${endpoint}/chat/completions`
        : `${endpoint}/v1/chat/completions`;
}
export function workflowProvidersFromEnvironment(env = process.env) {
    const cloudHosts = new Set((env.WORKFLOW_CLOUD_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean));
    const localEndpoint = checkedEndpoint("local", env.WORKFLOW_LOCAL_URL, cloudHosts);
    const cloudEndpoint = checkedEndpoint("cloud", env.WORKFLOW_CLOUD_URL, cloudHosts);
    const localInput = numberSetting(env.WORKFLOW_LOCAL_INPUT_USD_PER_MILLION_TOKENS);
    const localOutput = numberSetting(env.WORKFLOW_LOCAL_OUTPUT_USD_PER_MILLION_TOKENS);
    const cloudInput = numberSetting(env.WORKFLOW_CLOUD_INPUT_USD_PER_MILLION_TOKENS);
    const cloudOutput = numberSetting(env.WORKFLOW_CLOUD_OUTPUT_USD_PER_MILLION_TOKENS);
    const localMaxTokens = numberSetting(env.WORKFLOW_LOCAL_MAX_OUTPUT_TOKENS) ?? 2048;
    const cloudMaxTokens = numberSetting(env.WORKFLOW_CLOUD_MAX_OUTPUT_TOKENS) ?? 2048;
    return [
        {
            id: "manual",
            kind: "manual",
            label: "手動受渡し",
            model: "manual",
            available: true,
            costKnown: true,
            configVersion: "manual-v1",
        },
        {
            id: "local",
            kind: "local",
            label: "ローカルモデル",
            model: env.WORKFLOW_LOCAL_MODEL ?? "configured-local-model",
            available: Boolean(localEndpoint),
            costKnown: true,
            configVersion: endpointConfigVersion(`${env.WORKFLOW_LOCAL_CONFIG_VERSION ?? "local-v1"}${env.WORKFLOW_LOCAL_DISABLE_THINKING === "true" ? ":no-thinking" : ""}${env.WORKFLOW_LOCAL_JSON_MODE === "true" ? ":json" : ""}`, "local", localEndpoint),
            endpoint: localEndpoint,
            apiKey: env.WORKFLOW_LOCAL_API_KEY,
            inputUsdPerMillionTokens: localInput ?? 0,
            outputUsdPerMillionTokens: localOutput ?? 0,
            maxOutputTokens: localMaxTokens,
            disableThinking: env.WORKFLOW_LOCAL_DISABLE_THINKING === "true",
            jsonMode: env.WORKFLOW_LOCAL_JSON_MODE === "true",
        },
        {
            id: "cloud",
            kind: "cloud",
            label: "許可済み外部モデル",
            model: env.WORKFLOW_CLOUD_MODEL ?? "configured-cloud-model",
            available: Boolean(cloudEndpoint && env.WORKFLOW_CLOUD_API_KEY),
            costKnown: cloudInput !== undefined && cloudOutput !== undefined,
            configVersion: endpointConfigVersion(env.WORKFLOW_CLOUD_CONFIG_VERSION ?? "cloud-v1", "cloud", cloudEndpoint),
            endpoint: cloudEndpoint,
            apiKey: env.WORKFLOW_CLOUD_API_KEY,
            inputUsdPerMillionTokens: cloudInput,
            outputUsdPerMillionTokens: cloudOutput,
            maxOutputTokens: cloudMaxTokens,
        },
    ];
}
export async function invokeOpenAICompatible(provider, prompt, signal, maxOutputTokens, fetcher = fetch) {
    if ((provider.kind !== "cloud" && provider.kind !== "local") ||
        !provider.endpoint)
        throw new DomainError("model providerのendpoint設定がありません");
    const response = await fetcher(completionUrl(provider.endpoint), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(provider.apiKey
                ? { authorization: `Bearer ${provider.apiKey}` }
                : {}),
        },
        body: JSON.stringify({
            model: provider.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: maxOutputTokens,
            temperature: 0,
            ...(provider.kind === "local" && provider.disableThinking
                ? { chat_template_kwargs: { enable_thinking: false } }
                : {}),
            ...(provider.kind === "local" && provider.jsonMode
                ? { response_format: { type: "json_object" } }
                : {}),
        }),
        signal,
        redirect: "error",
    });
    if (!response.ok)
        throw new DomainError(`model providerがHTTP ${response.status}を返しました`);
    if (!response.body)
        throw new DomainError("model provider response bodyがありません");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.byteLength;
            if (size > 1_048_576) {
                await reader.cancel();
                throw new DomainError("model provider responseが1 MiBを超えました");
            }
            chunks.push(part.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(merged));
    }
    catch {
        throw new DomainError("model provider responseがJSONではありません");
    }
    if (!value || typeof value !== "object")
        throw new DomainError("model provider responseが不正です");
    const body = value;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length > 100_000)
        throw new DomainError("model provider responseに本文がないか上限を超えています");
    const promptTokens = body.usage?.prompt_tokens;
    const completionTokens = body.usage?.completion_tokens;
    if (body.usage &&
        (!Number.isSafeInteger(promptTokens) ||
            !Number.isSafeInteger(completionTokens) ||
            promptTokens < 0 ||
            completionTokens < 0))
        throw new DomainError("model providerのtoken usageが不正です");
    const actualCostUsd = typeof promptTokens === "number" &&
        typeof completionTokens === "number" &&
        provider.inputUsdPerMillionTokens !== undefined &&
        provider.outputUsdPerMillionTokens !== undefined
        ? (promptTokens * provider.inputUsdPerMillionTokens +
            completionTokens * provider.outputUsdPerMillionTokens) /
            1_000_000
        : null;
    return {
        response: content,
        actualCostUsd,
        model: body.model ?? provider.model,
        configVersion: provider.configVersion,
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
    };
}
//# sourceMappingURL=workflow-providers.js.map