// Навык Алисы → LLM через ai.starimg.ru (Cloudflare Worker).
// Гибридная схема + память диалога + долгосрочные факты.
//
// Быстрый ответ (до INLINE_WAIT_MS) — сразу. Медленный — «Секунду, думаю»,
// ответ досчитывается в фоне и отдаётся на следующую короткую реплику («ну», «ага»...).
//
// Память:
//   • диалог — последние HISTORY_MESSAGES сообщений, живёт HISTORY_TTL (переживает перезапуск навыка);
//   • факты — «Запомни, что …», хранятся бессрочно, до MAX_FACTS штук.
// Команды:
//   «запомни, что …»            — добавить факт
//   «что ты обо мне знаешь»      — перечислить факты
//   «забудь всё обо мне»         — удалить факты
//   «забудь» / «новая тема»      — очистить только диалог
//
// Нужно:
//   секрет ANTHROPIC_API_KEY — ключ ai.starimg.ru
//   KV-хранилище с привязкой ANSWERS (kv_namespaces в wrangler.jsonc)

const API_URL = "https://ai.starimg.ru/v1/messages";
const MODEL = "deepseek-v4.1-flash";
const INLINE_WAIT_MS = 2500;
const API_TIMEOUT_MS = 25000;
const SHORT_REPLY_WORDS = 3;
const HISTORY_MESSAGES = 10;
const HISTORY_TTL = 24 * 3600;   // диалог помним сутки
const ANSWER_TTL = 3600;
const MAX_FACTS = 30;

const RESET_DIALOG = ["забудь", "новая тема", "сначала", "начнём сначала", "начнем сначала"];
const RESET_FACTS = ["забудь всё обо мне", "забудь все обо мне", "забудь всё что знаешь", "забудь все что знаешь"];
const LIST_FACTS = ["что ты обо мне знаешь", "что ты помнишь", "что ты про меня знаешь", "что ты запомнил"];

const BASE_SYSTEM =
	"Ты голосовой ассистент в колонке. Отвечай по-русски, коротко (1–3 предложения), " +
	"без markdown, списков и эмодзи. Учитывай предыдущие реплики диалога.";

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
		const norm = normalize(utterance);

		// user_id есть, если пользователь авторизован в Яндексе; иначе — id устройства/приложения
		const uid =
			alice.session?.user?.user_id ||
			alice.session?.application?.application_id ||
			alice.session?.session_id ||
			"anon";
		const answerKey = `a:${uid}`;
		const historyKey = `h:${uid}`;
		const factsKey = `f:${uid}`;

		let text;

		if (!utterance) {
			text = "Привет! Задавайте вопрос.";
		} else if (RESET_FACTS.includes(norm)) {
			ctx.waitUntil(env.ANSWERS.delete(factsKey));
			text = "Хорошо, я забыл всё, что вы просили запомнить.";
		} else if (RESET_DIALOG.includes(norm)) {
			ctx.waitUntil(Promise.all([env.ANSWERS.delete(historyKey), env.ANSWERS.delete(answerKey)]));
			text = "Хорошо, начнём с чистого листа.";
		} else if (LIST_FACTS.includes(norm)) {
			const facts = (await env.ANSWERS.get(factsKey, "json")) || [];
			text = facts.length
				? "Я помню вот что: " + facts.join(". ") + "."
				: "Пока ничего. Скажите «запомни, что…», и я запомню.";
		} else if (/^запомни\b/.test(norm)) {
			const fact = utterance.replace(/^запомни[\s,:-]*(что\s+)?/i, "").trim();
			if (!fact) {
				text = "Что именно запомнить?";
			} else {
				const facts = (await env.ANSWERS.get(factsKey, "json")) || [];
				facts.push(fact);
				await env.ANSWERS.put(factsKey, JSON.stringify(facts.slice(-MAX_FACTS)));
				text = "Запомнил.";
			}
		} else {
			const saved = await env.ANSWERS.get(answerKey, "json");

			if (saved && isShort(norm)) {
				if (saved.status === "done") {
					text = saved.text;
					ctx.waitUntil(env.ANSWERS.delete(answerKey));
				} else {
					text = "Ещё думаю, секунду.";
				}
			} else {
				const [history, facts] = await Promise.all([
					env.ANSWERS.get(historyKey, "json"),
					env.ANSWERS.get(factsKey, "json"),
				]);
				const messages = [...(history || []), { role: "user", content: utterance }];
				const system = buildSystem(facts || []);

				const job = ask(system, messages, env.ANTHROPIC_API_KEY).then(async (res) => {
					if (res.ok) {
						const updated = [...messages, { role: "assistant", content: res.text }].slice(-HISTORY_MESSAGES);
						await env.ANSWERS.put(historyKey, JSON.stringify(updated), { expirationTtl: HISTORY_TTL });
					}
					return res.text;
				});

				const quick = await Promise.race([
					job,
					new Promise((resolve) => setTimeout(() => resolve(null), INLINE_WAIT_MS)),
				]);

				if (quick !== null) {
					text = quick;
					ctx.waitUntil(job);
					if (saved) ctx.waitUntil(env.ANSWERS.delete(answerKey));
				} else {
					await env.ANSWERS.put(answerKey, JSON.stringify({ status: "pending" }), { expirationTtl: ANSWER_TTL });
					ctx.waitUntil(
						job.then((answer) =>
							env.ANSWERS.put(answerKey, JSON.stringify({ status: "done", text: answer }), { expirationTtl: ANSWER_TTL })
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

function buildSystem(facts) {
	if (!facts.length) return BASE_SYSTEM;
	return (
		BASE_SYSTEM +
		"\n\nЧто пользователь просил запомнить о себе (используй, когда это к месту, но не перечисляй без повода):\n- " +
		facts.join("\n- ")
	);
}

function normalize(s) {
	return s.toLowerCase().replace(/ё/g, "е").replace(/[?!.,]/g, " ").replace(/\s+/g, " ").trim();
}

function isShort(norm) {
	return norm.split(" ").filter(Boolean).length <= SHORT_REPLY_WORDS;
}

async function ask(system, messages, apiKey) {
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
			body: JSON.stringify({ model: MODEL, max_tokens: 200, system, messages }),
		});

		if (!r.ok) {
			console.log("API error", r.status, await r.text());
			return { ok: false, text: "Не получилось получить ответ. Попробуйте ещё раз." };
		}

		const data = await r.json();
		console.log("Answered in", Date.now() - started, "ms, history:", messages.length - 1);
		const text = data.content?.map((b) => b.text || "").join("").trim();
		return text ? { ok: true, text } : { ok: false, text: "Пустой ответ." };
	} catch (e) {
		console.log("API exception after", Date.now() - started, "ms:", String(e));
		return { ok: false, text: "Ответ так и не пришёл. Спросите ещё раз." };
	} finally {
		clearTimeout(timer);
	}
}
