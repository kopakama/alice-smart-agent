// Навык Алисы → LLM через ai.starimg.ru (Cloudflare Worker).
// Гибридная схема + память диалога + долгосрочные факты.
//
// Быстрый ответ (до INLINE_WAIT_MS) — сразу. Медленный — «Секунду, думаю»,
// ответ досчитывается в фоне и отдаётся на следующую короткую реплику («ну», «ага»...).
//
// Память:
//   • диалог — последние HISTORY_MESSAGES сообщений, живёт HISTORY_TTL (переживает перезапуск навыка);
//   • факты — «Запомни, что …», хранятся бессрочно, до MAX_FACTS штук по MAX_FACT_LENGTH символов.
// Команды:
//   «запомни, что …»            — добавить факт
//   «что ты обо мне знаешь»      — перечислить факты
//   «забудь всё обо мне»         — удалить факты
//   «забудь» / «новая тема»      — очистить только диалог
//   «помощь» / «что ты умеешь»   — справка
//   «пока» / «хватит»            — завершить сессию
//
// Нужно:
//   секрет ANTHROPIC_API_KEY — ключ ai.starimg.ru
//   KV-хранилище с привязкой ANSWERS (kv_namespaces в wrangler.jsonc)
// Необязательно (защита включается, только если заданы):
//   секрет WEBHOOK_SECRET — секретный путь: Webhook URL навыка = https://<воркер>/<WEBHOOK_SECRET>
//   переменная SKILL_ID — id навыка в Яндекс Диалогах (wrangler.jsonc, vars)
//   переменная DAILY_LIMIT — вопросов к LLM в сутки на пользователя (по умолчанию 100, 0 — без лимита)

const API_URL = "https://ai.starimg.ru/v1/messages";
const MODEL = "deepseek-v4.1-flash";
const INLINE_WAIT_MS = 2500;
const API_TIMEOUT_MS = 25000;
const SHORT_REPLY_WORDS = 3;
const HISTORY_MESSAGES = 10;
const HISTORY_TTL = 24 * 3600;   // диалог помним сутки
const ANSWER_TTL = 3600;
const RATE_TTL = 2 * 24 * 3600;  // счётчик вопросов живёт дольше суток, чтобы не терять его на границе дней
const DAILY_LIMIT = 100;
const MAX_FACTS = 30;
const MAX_FACT_LENGTH = 200;

const RESET_DIALOG = ["забудь", "новая тема", "сначала", "начнём сначала", "начнем сначала"];
const RESET_FACTS = ["забудь всё обо мне", "забудь все обо мне", "забудь всё что знаешь", "забудь все что знаешь"];
const LIST_FACTS = ["что ты обо мне знаешь", "что ты помнишь", "что ты про меня знаешь", "что ты запомнил"];
const BYE = ["пока", "хватит", "стоп", "выход", "выйти", "до свидания", "закрой навык"];
const HELP = ["помощь", "что ты умеешь", "что ты можешь", "справка"];

const BASE_SYSTEM =
	"Ты голосовой ассистент в колонке. Отвечай по-русски, коротко (1–3 предложения), " +
	"без markdown, списков и эмодзи. Учитывай предыдущие реплики диалога.";

export default {
	async fetch(req, env, ctx) {
		// Если задан WEBHOOK_SECRET — отвечаем только на POST /<секрет>, иначе любой мог бы тратить наш баланс LLM.
		// Не задан — защита выключена, принимаем любой POST.
		const path = new URL(req.url).pathname;
		if (req.method !== "POST" || (env.WEBHOOK_SECRET && !safeEqual(path, `/${env.WEBHOOK_SECRET}`))) {
			return new Response("not found", { status: 404 });
		}

		let alice;
		try {
			alice = await req.json();
		} catch {
			return new Response("bad json", { status: 400 });
		}

		if (env.SKILL_ID && alice.session?.skill_id !== env.SKILL_ID) {
			return new Response("forbidden", { status: 403 });
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
		let endSession = false;

		if (!utterance) {
			text = "Привет! Задавайте вопрос.";
		} else if (BYE.includes(norm)) {
			text = "До свидания!";
			endSession = true;
		} else if (HELP.includes(norm)) {
			text =
				"Задайте любой вопрос, отвечу коротко. Скажите «запомни, что…», чтобы я запомнил факт о вас, " +
				"«что ты обо мне знаешь» — перечислю, «забудь» — начнём тему заново, «пока» — выйду.";
		} else if (RESET_FACTS.includes(norm)) {
			ctx.waitUntil(kvDelete(env, factsKey));
			text = "Хорошо, я забыл всё, что вы просили запомнить.";
		} else if (RESET_DIALOG.includes(norm)) {
			ctx.waitUntil(Promise.all([kvDelete(env, historyKey), kvDelete(env, answerKey)]));
			text = "Хорошо, начнём с чистого листа.";
		} else if (LIST_FACTS.includes(norm)) {
			const facts = (await kvGet(env, factsKey)) || [];
			text = facts.length
				? "Я помню вот что: " + facts.join(". ") + "."
				: "Пока ничего. Скажите «запомни, что…», и я запомню.";
		} else if (/^запомни(\s|$)/.test(norm)) {
			const fact = utterance.replace(/^запомни[\s,:-]*(что\s+)?/i, "").trim();
			if (!fact) {
				text = "Что именно запомнить?";
			} else if (fact.length > MAX_FACT_LENGTH) {
				text = `Слишком длинно. Сократите до ${MAX_FACT_LENGTH} символов.`;
			} else {
				const facts = (await kvGet(env, factsKey)) || [];
				facts.push(fact);
				text = (await kvPut(env, factsKey, JSON.stringify(facts.slice(-MAX_FACTS))))
					? "Запомнил."
					: "Не получилось сохранить. Попробуйте позже.";
			}
		} else {
			const saved = await kvGet(env, answerKey);

			if (saved && isShort(norm)) {
				if (saved.status === "done") {
					text = saved.text;
					ctx.waitUntil(kvDelete(env, answerKey));
				} else {
					text = "Ещё думаю, секунду.";
				}
			} else if (await overLimit(env, uid)) {
				text = "На сегодня лимит вопросов исчерпан. Попробуйте завтра.";
			} else {
				const [history, facts] = await Promise.all([kvGet(env, historyKey), kvGet(env, factsKey)]);
				const messages = [...(history || []), { role: "user", content: utterance }];
				const system = buildSystem(facts || []);

				const job = ask(system, messages, env.ANTHROPIC_API_KEY).then(async (res) => {
					if (res.ok) {
						const updated = [...messages, { role: "assistant", content: res.text }].slice(-HISTORY_MESSAGES);
						await kvPut(env, historyKey, JSON.stringify(updated), { expirationTtl: HISTORY_TTL });
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
					if (saved) ctx.waitUntil(kvDelete(env, answerKey));
				} else {
					await kvPut(env, answerKey, JSON.stringify({ status: "pending" }), { expirationTtl: ANSWER_TTL });
					ctx.waitUntil(
						job.then((answer) =>
							kvPut(env, answerKey, JSON.stringify({ status: "done", text: answer }), { expirationTtl: ANSWER_TTL })
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
				response: { text: text.slice(0, 1024), end_session: endSession },
			}),
			{ headers: { "Content-Type": "application/json; charset=utf-8" } }
		);
	},
};

// KV на бесплатном плане ограничен (1000 записей в сутки): при сбое отвечаем пользователю всё равно.
async function kvGet(env, key) {
	try {
		return await env.ANSWERS.get(key, "json");
	} catch (e) {
		console.log("KV get failed", key, String(e));
		return null;
	}
}

async function kvPut(env, key, value, options) {
	try {
		await env.ANSWERS.put(key, value, options);
		return true;
	} catch (e) {
		console.log("KV put failed", key, String(e));
		return false;
	}
}

async function kvDelete(env, key) {
	try {
		await env.ANSWERS.delete(key);
	} catch (e) {
		console.log("KV delete failed", key, String(e));
	}
}

// Лимит вопросов к LLM на пользователя в сутки (UTC). Если KV недоступен — не блокируем.
async function overLimit(env, uid) {
	const raw = env.DAILY_LIMIT;
	const limit = raw === undefined || raw === "" || Number.isNaN(Number(raw)) ? DAILY_LIMIT : Number(raw);
	if (limit <= 0) return false;

	const key = `r:${uid}:${new Date().toISOString().slice(0, 10)}`;
	const used = Number(await kvGet(env, key)) || 0;
	if (used >= limit) return true;
	await kvPut(env, key, String(used + 1), { expirationTtl: RATE_TTL });
	return false;
}

// Сравнение за постоянное время, чтобы секретный путь нельзя было подобрать по времени ответа.
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

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
