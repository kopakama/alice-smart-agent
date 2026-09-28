// Навык Алисы → gpt-6-luna через ai.starimg.ru (Cloudflare Worker), гибридная схема.
// Быстрый ответ (до INLINE_WAIT_MS) — сразу. Медленный — «Секунду, думаю»,
// ответ досчитывается в фоне и отдаётся на следующую короткую реплику («ну», «ага», «да»...).
//
// Нужно:
//   секрет ANTHROPIC_API_KEY — ключ ai.starimg.ru
//   KV-хранилище с привязкой ANSWERS (kv_namespaces в wrangler.jsonc)

const API_URL = "https://ai.starimg.ru/v1/messages";
const MODEL = "deepseek-v4.1-flash";
const INLINE_WAIT_MS = 2500;   // сколько ждём «вживую» — Алиса даёт ~3 с
const API_TIMEOUT_MS = 25000;  // фоновый запрос Алиса не ждёт
const SHORT_REPLY_WORDS = 3;   // реплика из ≤3 слов при ожидающем ответе = «давай ответ»

export default {
	async fetch(req, env, ctx) {
		if (req.method !== "POST") return new Response("ok");

		let alice;
		try {
			alice = await req.json();
		} catch {
			return new Response("bad json", { status: 400 });
		}

		const utterance = (alice.request?.original_utterance || "").trim();
		const key = alice.session?.session_id || alice.session?.user_id || "anon";

		let text;

		if (!utterance) {
			text = "Привет! Задавайте вопрос.";
		} else {
			const saved = await env.ANSWERS.get(key, "json");

			if (saved && isShort(utterance)) {
				// ждём или уже есть отложенный ответ — короткая реплика его забирает
				if (saved.status === "done") {
					text = saved.text;
					ctx.waitUntil(env.ANSWERS.delete(key));
				} else {
					text = "Ещё думаю, секунду.";
				}
			} else {
				// новый вопрос
				const job = ask(utterance, env.ANTHROPIC_API_KEY);
				const quick = await Promise.race([
					job,
					new Promise((resolve) => setTimeout(() => resolve(null), INLINE_WAIT_MS)),
				]);

				if (quick !== null) {
					text = quick;
					if (saved) ctx.waitUntil(env.ANSWERS.delete(key));
				} else {
					await env.ANSWERS.put(key, JSON.stringify({ status: "pending" }), { expirationTtl: 3600 });
					ctx.waitUntil(
						job.then((answer) =>
							env.ANSWERS.put(key, JSON.stringify({ status: "done", text: answer }), { expirationTtl: 3600 })
						)
					);
					text = "Секунду, думаю.";
				}
			}
		}

		return new Response(
			JSON.stringify({
				version: alice.version,
				session: alice.session,
				response: { text: text.slice(0, 1024), end_session: false },
			}),
			{ headers: { "Content-Type": "application/json; charset=utf-8" } }
		);
	},
};

function isShort(utterance) {
	const words = utterance.replace(/[?!.,]/g, " ").trim().split(/\s+/).filter(Boolean);
	return words.length <= SHORT_REPLY_WORDS;
}

async function ask(prompt, apiKey) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
	const started = Date.now();
	try {
		const r = await fetch(API_URL, {
			method: "POST",
			signal: ctrl.signal,
			headers: {
				"x-api-key": apiKey,
				"Authorization": `Bearer ${apiKey}`,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 200,
				system:
					"Ты голосовой ассистент в колонке. Отвечай по-русски, коротко (1–3 предложения), без markdown, списков и эмодзи. Не рассуждай долго, сразу давай краткий ответ",
				messages: [{ role: "user", content: prompt }],
			}),
		});

		if (!r.ok) {
			console.log("API error", r.status, await r.text());
			return "Не получилось получить ответ. Попробуйте ещё раз.";
		}

		const data = await r.json();
		console.log("Answered in", Date.now() - started, "ms");
		return data.content?.map((b) => b.text || "").join("") || "Пустой ответ.";
	} catch (e) {
		console.log("API exception after", Date.now() - started, "ms:", String(e));
		return "Ответ так и не пришёл. Спросите ещё раз.";
	} finally {
		clearTimeout(timer);
	}
}
