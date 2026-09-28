import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src";

const SKILL_ID = env.SKILL_ID;

function aliceBody(utterance, { skillId = SKILL_ID, userId = "user-1" } = {}) {
	return {
		version: "1.0",
		session: { skill_id: skillId, user: { user_id: userId }, session_id: "s-1" },
		request: { original_utterance: utterance },
	};
}

// Вызов воркера напрямую с нужным окружением; ждём фоновые записи в KV.
async function call({ path = "/", method = "POST", body, extraEnv = {} } = {}) {
	const req = new Request(`http://example.com${path}`, {
		method,
		body: method === "POST" ? JSON.stringify(body ?? aliceBody("")) : undefined,
	});
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, { ...env, ...extraEnv }, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function say(utterance, opts) {
	const res = await call({ body: aliceBody(utterance, opts) });
	expect(res.status).toBe(200);
	return res.json();
}

describe("защита вебхука", () => {
	it("на GET отвечает 404", async () => {
		expect((await call({ method: "GET" })).status).toBe(404);
	});

	it("без WEBHOOK_SECRET принимает POST на любой путь", async () => {
		expect((await call({ path: "/anything" })).status).toBe(200);
	});

	it("с WEBHOOK_SECRET отвечает только на секретный путь", async () => {
		const extraEnv = { WEBHOOK_SECRET: "s3cret" };
		expect((await call({ path: "/", extraEnv })).status).toBe(404);
		expect((await call({ path: "/wrong", extraEnv })).status).toBe(404);
		expect((await call({ path: "/s3cret", extraEnv })).status).toBe(200);
	});

	it("отклоняет чужой skill_id", async () => {
		const res = await call({ body: aliceBody("привет", { skillId: "other" }) });
		expect(res.status).toBe(403);
	});

	it("на битый JSON отвечает 400", async () => {
		const res = await worker.fetch(new Request("http://example.com/", { method: "POST", body: "{" }), env, createExecutionContext());
		expect(res.status).toBe(400);
	});

	it("работает и через SELF (реальная привязка из wrangler.jsonc)", async () => {
		const res = await SELF.fetch("http://example.com/", { method: "POST", body: JSON.stringify(aliceBody("")) });
		expect(res.status).toBe(200);
	});
});

describe("команды", () => {
	it("приветствует на пустую реплику", async () => {
		const data = await say("");
		expect(data.response.text).toContain("Привет");
		expect(data.response.end_session).toBe(false);
	});

	it("возвращает version и session из запроса", async () => {
		const data = await say("помощь");
		expect(data.version).toBe("1.0");
		expect(data.session.session_id).toBe("s-1");
	});

	it("справка", async () => {
		const data = await say("Что ты умеешь?");
		expect(data.response.text).toContain("запомни");
		expect(data.response.end_session).toBe(false);
	});

	it("«пока» завершает сессию", async () => {
		const data = await say("Пока!");
		expect(data.response.end_session).toBe(true);
	});

	it("запоминает, перечисляет и забывает факты", async () => {
		expect((await say("Запомни, что я люблю чай")).response.text).toBe("Запомнил.");
		expect((await say("что ты обо мне знаешь")).response.text).toContain("я люблю чай");
		expect((await say("забудь всё обо мне")).response.text).toContain("забыл");
		expect((await say("что ты обо мне знаешь")).response.text).toContain("Пока ничего");
	});

	it("факты разных пользователей не смешиваются", async () => {
		await say("запомни, что я люблю чай", { userId: "alice" });
		const data = await say("что ты обо мне знаешь", { userId: "bob" });
		expect(data.response.text).toContain("Пока ничего");
	});

	it("просит уточнить, если нечего запомнить", async () => {
		expect((await say("запомни")).response.text).toBe("Что именно запомнить?");
	});

	it("отклоняет слишком длинный факт", async () => {
		const data = await say("запомни, что " + "а".repeat(300));
		expect(data.response.text).toContain("Слишком длинно");
		expect((await say("что ты обо мне знаешь")).response.text).toContain("Пока ничего");
	});

	it("хранит не больше 30 фактов", async () => {
		for (let i = 1; i <= 32; i++) await say(`запомни, что факт номер ${i}`);
		const text = (await say("что ты обо мне знаешь")).response.text;
		expect(text).not.toContain("факт номер 1.");
		expect(text).not.toContain("факт номер 2.");
		expect(text).toContain("факт номер 32");
	});

	it("сообщает, если KV не смог сохранить факт", async () => {
		const brokenKv = {
			get: async () => null,
			put: async () => {
				throw new Error("KV put() limit exceeded");
			},
			delete: async () => {},
		};
		const res = await call({ body: aliceBody("запомни, что я люблю чай"), extraEnv: { ANSWERS: brokenKv } });
		expect((await res.json()).response.text).toContain("Не получилось сохранить");
	});
});

describe("лимит вопросов", () => {
	const today = () => new Date().toISOString().slice(0, 10);

	it("не пускает к LLM после исчерпания лимита", async () => {
		await env.ANSWERS.put(`r:user-1:${today()}`, "5");
		const res = await call({ body: aliceBody("сколько будет два плюс два"), extraEnv: { DAILY_LIMIT: "5" } });
		expect((await res.json()).response.text).toContain("лимит");
	});

	it("команды не тратят лимит и работают при исчерпанном лимите", async () => {
		await env.ANSWERS.put(`r:user-1:${today()}`, "5");
		const res = await call({ body: aliceBody("запомни, что я люблю чай"), extraEnv: { DAILY_LIMIT: "5" } });
		expect((await res.json()).response.text).toBe("Запомнил.");
	});
});

describe("ответы LLM", () => {
	afterEach(() => vi.restoreAllMocks());

	const llmReply = (text) =>
		new Response(JSON.stringify({ content: [{ type: "text", text }] }), { headers: { "content-type": "application/json" } });

	function deferred() {
		let resolve;
		const promise = new Promise((r) => (resolve = r));
		return { promise, resolve };
	}

	// Запрос, фоновые задачи которого ещё не завершены: done() дожидается их.
	async function start(utterance, userId) {
		const ctx = createExecutionContext();
		const req = new Request("http://example.com/", { method: "POST", body: JSON.stringify(aliceBody(utterance, { userId })) });
		const res = await worker.fetch(req, env, ctx);
		return { text: (await res.json()).response.text, done: () => waitOnExecutionContext(ctx) };
	}

	it("быстрый ответ отдаёт сразу и сохраняет историю", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => llmReply("Четыре."));
		expect((await say("сколько будет два плюс два", { userId: "quick" })).response.text).toBe("Четыре.");
		const history = await env.ANSWERS.get("h:quick", "json");
		expect(history).toEqual([
			{ role: "user", content: "сколько будет два плюс два" },
			{ role: "assistant", content: "Четыре." },
		]);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("передаёт историю и факты в следующий запрос", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => llmReply("Ок."));
		await say("запомни, что меня зовут Артём", { userId: "ctx" });
		await say("первый вопрос", { userId: "ctx" });
		await say("второй вопрос", { userId: "ctx" });
		const body = JSON.parse(spy.mock.calls[1][1].body);
		expect(body.system).toContain("меня зовут Артём");
		expect(body.messages.map((m) => m.content)).toEqual(["первый вопрос", "Ок.", "второй вопрос"]);
	});

	it("считает вопросы в лимите", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => llmReply("Ок."));
		await say("вопрос", { userId: "counter" });
		await say("ещё вопрос", { userId: "counter" });
		const key = `r:counter:${new Date().toISOString().slice(0, 10)}`;
		expect(await env.ANSWERS.get(key)).toBe("2");
	});

	it("при ошибке API не пишет историю", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
		expect((await say("вопрос", { userId: "err" })).response.text).toContain("Не получилось");
		expect(await env.ANSWERS.get("h:err")).toBeNull();
	});

	it("отвечает на ping без LLM", async () => {
		const spy = vi.spyOn(globalThis, "fetch");
		expect((await say("ping")).response.text).toBe("pong");
		expect(spy).not.toHaveBeenCalled();
	});

	it("медленный ответ отдаёт на «ну»", async () => {
		const d = deferred();
		vi.spyOn(globalThis, "fetch").mockImplementation(() => d.promise);
		const q = await start("расскажи длинную историю", "slow");
		expect(q.text).toBe("Секунду, думаю.");
		expect((await say("ну", { userId: "slow" })).response.text).toBe("Ещё думаю, секунду.");
		d.resolve(llmReply("Готовый ответ."));
		await q.done();
		expect((await say("Ну?", { userId: "slow" })).response.text).toBe("Готовый ответ.");
		expect(await env.ANSWERS.get("a:slow")).toBeNull();
	});

	it("старый медленный ответ не перезаписывает ответ на новый вопрос", async () => {
		const d1 = deferred();
		const d2 = deferred();
		vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce(() => d1.promise)
			.mockImplementationOnce(() => d2.promise);
		const q1 = await start("первый длинный вопрос", "race");
		const q2 = await start("второй длинный вопрос", "race");
		d2.resolve(llmReply("Ответ на второй."));
		await q2.done();
		d1.resolve(llmReply("Ответ на первый."));
		await q1.done();
		expect((await say("ну", { userId: "race" })).response.text).toBe("Ответ на второй.");
	});

	it("не залипает на «думаю», если задание умерло", async () => {
		const stale = { status: "pending", id: "x", started: Date.now() - 60_000 };
		await env.ANSWERS.put("a:stale", JSON.stringify(stale));
		expect((await say("ну", { userId: "stale" })).response.text).toContain("так и не пришёл");
		expect(await env.ANSWERS.get("a:stale")).toBeNull();
	});

	it("запись старого формата без started считается протухшей", async () => {
		await env.ANSWERS.put("a:legacy", JSON.stringify({ status: "pending" }));
		expect((await say("ну", { userId: "legacy" })).response.text).toContain("так и не пришёл");
	});

	it("короткий новый вопрос не перехватывается готовым ответом", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => llmReply("Завтра солнечно."));
		await env.ANSWERS.put("a:short", JSON.stringify({ status: "done", id: "x", text: "Старый ответ." }));
		expect((await say("а погода завтра?", { userId: "short" })).response.text).toBe("Завтра солнечно.");
		expect(await env.ANSWERS.get("a:short")).toBeNull();
	});
});

describe("качество ответов", () => {
	afterEach(() => vi.restoreAllMocks());

	const llmReply = (text, stop_reason = "end_turn") =>
		new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason }), {
			headers: { "content-type": "application/json" },
		});

	function deferred() {
		let resolve;
		const promise = new Promise((r) => (resolve = r));
		return { promise, resolve };
	}

	it("параллельный медленный вопрос не затирает историю нового", async () => {
		const d1 = deferred();
		vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce(() => d1.promise)
			.mockImplementationOnce(async () => llmReply("Ответ на второй."));

		const ctx1 = createExecutionContext();
		const req1 = new Request("http://example.com/", {
			method: "POST",
			body: JSON.stringify(aliceBody("первый длинный вопрос", { userId: "hist" })),
		});
		const res1 = await worker.fetch(req1, env, ctx1);
		expect((await res1.json()).response.text).toBe("Секунду, думаю.");

		expect((await say("второй вопрос", { userId: "hist" })).response.text).toBe("Ответ на второй.");

		d1.resolve(llmReply("Ответ на первый."));
		await waitOnExecutionContext(ctx1);

		// Первый ответ пользователь так и не услышал — в истории только второй обмен.
		expect(await env.ANSWERS.get("h:hist", "json")).toEqual([
			{ role: "user", content: "второй вопрос" },
			{ role: "assistant", content: "Ответ на второй." },
		]);
	});

	it("отложенный ответ попадает в историю", async () => {
		const d = deferred();
		vi.spyOn(globalThis, "fetch").mockImplementation(() => d.promise);
		const ctx = createExecutionContext();
		const req = new Request("http://example.com/", {
			method: "POST",
			body: JSON.stringify(aliceBody("долгий вопрос", { userId: "hist-slow" })),
		});
		await worker.fetch(req, env, ctx);
		d.resolve(llmReply("Долгий ответ."));
		await waitOnExecutionContext(ctx);
		expect(await env.ANSWERS.get("h:hist-slow", "json")).toEqual([
			{ role: "user", content: "долгий вопрос" },
			{ role: "assistant", content: "Долгий ответ." },
		]);
	});

	it("убирает markdown, списки и эмодзи", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			llmReply("**Москва** — столица 🙂\n\n- Кремль\n- Красная площадь\n\nПодробнее [тут](https://example.com).")
		);
		expect((await say("расскажи про москву", { userId: "md" })).response.text).toBe(
			"Москва — столица. Кремль. Красная площадь. Подробнее тут."
		);
	});

	it("обрезает оборванный ответ до последнего предложения", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			llmReply("Первое предложение. Второе предложение. А третье оборвало", "max_tokens")
		);
		expect((await say("длинный рассказ", { userId: "cut" })).response.text).toBe("Первое предложение. Второе предложение.");
	});

	it("не обрезает законченный ответ", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => llmReply("Да. Но есть нюанс"));
		expect((await say("вопрос", { userId: "nocut" })).response.text).toBe("Да. Но есть нюанс");
	});

	it("укладывает ответ в 1024 символа по границе предложения", async () => {
		const long = "Это довольно длинное предложение для проверки. ".repeat(40);
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => llmReply(long));
		const text = (await say("вопрос", { userId: "long" })).response.text;
		expect(text.length).toBeLessThanOrEqual(1024);
		expect(text.endsWith("проверки.")).toBe(true);
	});

	it("повторяет запрос при 5xx", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementationOnce(async () => new Response("bad gateway", { status: 502 }))
			.mockImplementationOnce(async () => llmReply("Со второго раза."));
		expect((await say("вопрос", { userId: "retry" })).response.text).toBe("Со второго раза.");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("повторяет запрос при сетевой ошибке", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementationOnce(async () => {
				throw new Error("network down");
			})
			.mockImplementationOnce(async () => llmReply("Сеть вернулась."));
		expect((await say("вопрос", { userId: "retry-net" })).response.text).toBe("Сеть вернулась.");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("не повторяет запрос при 4xx", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad key", { status: 401 }));
		expect((await say("вопрос", { userId: "no-retry" })).response.text).toContain("Не получилось");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("сдаётся после двух неудачных попыток", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
		expect((await say("вопрос", { userId: "give-up" })).response.text).toContain("Не получилось");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("настройки модели", () => {
	afterEach(() => vi.restoreAllMocks());

	const ok = async () =>
		new Response(JSON.stringify({ content: [{ type: "text", text: "Ок." }] }), { headers: { "content-type": "application/json" } });

	it("берёт MODEL и API_URL из wrangler.jsonc", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(ok);
		await say("вопрос", { userId: "cfg" });
		expect(spy.mock.calls[0][0]).toBe(env.API_URL);
		expect(JSON.parse(spy.mock.calls[0][1].body).model).toBe(env.MODEL);
	});

	it("переменные переопределяют значения по умолчанию", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(ok);
		const extraEnv = { API_URL: "https://other.example/v1/messages", MODEL: "other-model" };
		await call({ body: aliceBody("вопрос", { userId: "cfg-2" }), extraEnv });
		expect(spy.mock.calls[0][0]).toBe("https://other.example/v1/messages");
		expect(JSON.parse(spy.mock.calls[0][1].body).model).toBe("other-model");
	});

	it("без переменных работает на значениях по умолчанию", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(ok);
		await call({ body: aliceBody("вопрос", { userId: "cfg-3" }), extraEnv: { API_URL: undefined, MODEL: undefined } });
		expect(spy.mock.calls[0][0]).toBe("https://ai.starimg.ru/v1/messages");
		expect(JSON.parse(spy.mock.calls[0][1].body).model).toBe("deepseek-v4.1-flash");
	});
});
