import os
import sys
import json
import asyncio
import aiosqlite
import backoff
import requests
import cv2
import base64
import io
from google import genai
from typing import Dict, Any, Optional
from langgraph.graph import StateGraph, END

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

def _send_telegram_sync(token: str, chat_id: str, message: str, video_path: str = None):
    url_base = f"https://api.telegram.org/bot{token}"
    try:
        if video_path and os.path.exists(video_path):
            url = f"{url_base}/sendVideo"
            with open(video_path, "rb") as f:
                files = {"video": f}
                data = {"chat_id": chat_id, "caption": message, "parse_mode": "HTML"}
                resp = requests.post(url, data=data, files=files, timeout=60)
        else:
            url = f"{url_base}/sendMessage"
            data = {"chat_id": chat_id, "text": message, "parse_mode": "HTML"}
            resp = requests.post(url, data=data, timeout=15)
        
        if resp.status_code != 200:
            print(f"  [TELEGRAM ERROR] API returned {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"  [TELEGRAM EXCEPTION] {e}")

async def send_telegram_alert(token: str, chat_id: str, message: str, video_path: str = None):
    await asyncio.to_thread(_send_telegram_sync, token, chat_id, message, video_path)
from core.database.db import SYSTEM_DB_PATH, QUEUE_DB_PATH
from shared.schemas import Event

EVENT_STORAGE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'edge', 'storage', 'events'))

class GraphState(dict):
    event: Optional[Event]
    context_rules: str
    biomechanical_dossier: Optional[Dict[str, Any]]
    video_analysis: Optional[Dict[str, Any]]
    final_verdict: Optional[Dict[str, Any]]
    error: Optional[str]
    model_id: str
    model_source: str
    enable_fallback: bool

async def get_best_model(client: genai.Client) -> str:
    """Staff Level: Automatically discover the best available Flash model."""
    try:
        models = client.models.list()
        flash_models = [m.name for m in models if 'flash' in m.name.lower()]
        for version in ['2.5', '2.0', '1.5']:
            for m in flash_models:
                if version in m:
                    return m.replace('models/', '')
        return flash_models[0].replace('models/', '') if flash_models else 'gemini-1.5-flash'
    except Exception as e:
        print(f"  [AI CONFIG ERROR] Model discovery failed: {e}")
        return 'gemini-1.5-flash'

async def node_poller(state: GraphState) -> Dict[str, Any]:
    try:
        async with aiosqlite.connect(QUEUE_DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM events WHERE status = 'PENDING' ORDER BY id ASC LIMIT 1") as cursor:
                row = await cursor.fetchone()
                if row:
                    data = dict(row)
                    if 'timestamp' not in data or data['timestamp'] is None: data['timestamp'] = 0.0
                    event = Event(**data)
                    await db.execute("UPDATE events SET status = 'PROCESSING' WHERE id = ?", (event.id,))
                    await db.commit()
                    return {"event": event}
    except Exception as e: print(f"  [BRAIN ERROR] Poller: {e}")
    return {"event": None}

async def node_contextualizer(state: GraphState) -> Dict[str, Any]:
    if not state.get("event"): return {}
    try:
        async with aiosqlite.connect(SYSTEM_DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT value FROM config WHERE key = 'brain_rules'") as cursor:
                row = await cursor.fetchone()
                rules = row['value'] if row else "Analyze for shoplifting or product concealment."
            
            async with db.execute("SELECT key, value FROM config WHERE key IN ('model_source', 'gemini_api_key', 'enable_fallback')") as cursor:
                rows = await cursor.fetchall()
                config_dict = {r['key']: r['value'] for r in rows}
            
            model_source = config_dict.get('model_source', 'hybrid').lower()
            api_key = config_dict.get('gemini_api_key') or os.getenv("GEMINI_API_KEY")
            enable_fallback = config_dict.get('enable_fallback', 'false').lower() == 'true'
            
            if api_key:
                client = genai.Client(api_key=api_key)
                model_id = await get_best_model(client)
                print(f"  [AI CONFIG] Best Model Discovered: {model_id} | Mode: {model_source} | Fallback: {enable_fallback}")
                return {"context_rules": rules, "model_id": model_id, "model_source": model_source, "enable_fallback": enable_fallback}
            
            print(f"  [AI CONFIG] Gemini Key missing. Fallback: {enable_fallback}")
            return {"context_rules": rules, "model_id": "gemini-1.5-flash", "model_source": model_source, "enable_fallback": enable_fallback}
    except Exception as e: print(f"  [BRAIN ERROR] Context: {e}")
    return {"context_rules": "", "model_id": "gemini-1.5-flash", "model_source": "hybrid", "enable_fallback": False}

async def node_biomechanical_analyst(state: GraphState) -> Dict[str, Any]:
    event = state.get("event")
    if not event: return {}
    try:
        payload = {}
        if event.payload_json:
            try: payload = json.loads(event.payload_json)
            except: pass
        
        intent_analysis = payload.get("intent_analysis", {})
        reasons = intent_analysis.get("reasons", [])
        reasons_str = "\n".join([f"  - {r}" for r in reasons]) if reasons else "  - Nenhuma anomalia biomecânica detectada."
        
        dossier = f"""RELATÓRIO BIOMECÂNICO E DE TRAJETÓRIA (Edge YOLO)
- ID do Personagem: {payload.get("p_id", "N/A")}
- Nível de Risco Calculado na Borda: {intent_analysis.get("risk_level", "desconhecido")} (Score: {intent_analysis.get("intent_score", 0.0)})
- Duração da Observação: {payload.get("video_duration_s", 0.0)} segundos
- Data/Hora do Registro: {payload.get("event_datetime", "N/A")}
- Produtos com Suspeita de Ocultação: {', '.join(payload.get("products", []))}

Evidências Biomecânicas Detectadas na Borda:
{reasons_str}"""
        return {"biomechanical_dossier": {"dossier_text": dossier, "products": payload.get("products", [])}}
    except Exception as e:
        print(f"  [BIO ANALYST ERROR] {e}")
        return {"biomechanical_dossier": {"dossier_text": "Falha ao compilar dossiê biomecânico.", "products": []}}

async def node_video_investigator(state: GraphState) -> Dict[str, Any]:
    event = state.get("event")
    if not event: return {}
    
    async with aiosqlite.connect(SYSTEM_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT value FROM config WHERE key = 'gemini_api_key'") as cursor:
            row = await cursor.fetchone()
            api_key = row['value'] if row else os.getenv("GEMINI_API_KEY")
            
    if not api_key:
        return {"video_analysis": {"error": "Chave API ausente", "description": "Falha na análise de vídeo por falta de credenciais."}}
        
    video_path = os.path.join(EVENT_STORAGE, event.video_path)
    if not os.path.exists(video_path):
        return {"video_analysis": {"error": "Vídeo ausente", "description": "Arquivo de vídeo ausente na borda."}}
        
    try:
        client = genai.Client(api_key=api_key)
        model_id = state.get("model_id", "gemini-1.5-flash")
        
        print(f"  [INVESTIGADOR DE VÍDEO] Enviando vídeo {event.video_path} para o {model_id}...")
        video_file = client.files.upload(file=video_path)
        while video_file.state.name == 'PROCESSING':
            await asyncio.sleep(2)
            video_file = client.files.get(name=video_file.name)
            
        prompt = """Você é um Investigador de Vídeo Multimodal em uma equipe de prevenção de perdas.
Assista a este vídeo completo da câmera de segurança.
Seu objetivo é descrever as ações físicas da pessoa em relação aos produtos na cena:
1. A pessoa pega o produto? Se sim, em qual momento do vídeo?
2. O que ela faz com o produto depois de pegar? Coloca em um carrinho, cesta, devolve na prateleira, ou o esconde sob as vestes, casaco, bolsa ou bolsos?
3. Descreva detalhadamente a aparência física do suspeito (ex: cor e tipo da camisa, calça, cabelo, se usa óculos, boné, etc.).

Escreva sua resposta de forma puramente factual e objetiva. Responda em português do Brasil."""

        response = client.models.generate_content(
            model=model_id,
            contents=[prompt, video_file]
        )
        
        desc = response.text.strip()
        print("  [INVESTIGADOR DE VÍDEO] Análise visual concluída.")
        return {"video_analysis": {"description": desc}}
    except Exception as e:
        print(f"  [INVESTIGADOR DE VÍDEO ERROR] {e}")
        return {"video_analysis": {"error": str(e), "description": f"Falha na análise do vídeo: {e}"}}

async def node_security_auditor(state: GraphState) -> Dict[str, Any]:
    event = state.get("event")
    if not event: return {}
    
    async with aiosqlite.connect(SYSTEM_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT value FROM config WHERE key = 'gemini_api_key'") as cursor:
            row = await cursor.fetchone()
            api_key = row['value'] if row else os.getenv("GEMINI_API_KEY")
            
    if not api_key:
        return {"final_verdict": {"is_theft": False, "confidence": 0.0, "classification": "INOCENTADO", "telegram_report": "Erro: Chave API ausente."}}
        
    dossier = state.get("biomechanical_dossier", {}).get("dossier_text", "")
    visual_desc = state.get("video_analysis", {}).get("description", "")
    
    prompt = f"""Você é o Auditor de Prevenção de Perdas sênior (Líder da Equipe SOC).
Seu papel é analisar os pareceres dos dois agentes abaixo e tomar a decisão final se ocorreu um furto/ocultação de produto ou se a ação foi inocente.

PARECER DO ANALISTA BIOMECÂNICO (Métricas de Borda):
{dossier}

PARECER DO INVESTIGADOR DE VÍDEO (Descrição Visual do Vídeo):
{visual_desc}

REGRAS GERAIS DE AUDITORIA (DÚVIDA RAZOÁVEL):
1. A ocultação só é confirmada se o produto for inserido sob roupas, jaquetas, bolsos de calça/casaco ou bolsas fechadas de forma a sumir de vista intencionalmente. Nesse caso, classifique como furto (is_theft = true, classification = 'FURTO_CONFIRMADO').
2. Caso o produto seja colocado em carrinhos de bebê, cestas/carrinhos da loja, ou sacolas de compras abertas, NÃO classifique como furto. Classifique como 'INOCENTADO' ou, se houver comportamento altamente anômalo de olhar ao redor/vigilância, classifique no máximo como 'SUSPEITO' (is_theft = false, classification = 'SUSPEITO').
3. Se a pessoa apenas segurou o produto, colocou no carrinho/cesta comum, colocou de volta ou organizou na prateleira/gôndola sem ocultar, classifique como inocente (is_theft = false, classification = 'INOCENTADO').
4. IGNORE pertences pessoais do próprio cliente (como celulares, carteiras, chaves ou óculos). Se a pessoa apenas manuseou o próprio telefone ou guardou um pertence pessoal, classifique imediatamente como 'INOCENTADO'.
5. Respeite as regras de contexto do cliente: {state.get("context_rules", "")}

Responda APENAS em português do Brasil, utilizando estritamente a estrutura JSON abaixo:
{{"is_theft": bool, "confidence": float, "suspect_description": "detalhes físicos e vestimentas do suspeito", "telegram_report": "resumo direto de 2-3 frases sobre o ocorrido para o lojista", "products_stolen": ["lista dos produtos furtados"], "classification": "INOCENTADO|SUSPEITO|FURTO_CONFIRMADO"}}"""

    try:
        client = genai.Client(api_key=api_key)
        model_id = state.get("model_id", "gemini-1.5-flash")
        print(f"  [AUDITOR DE SEGURANÇA] Rodando auditoria final com {model_id}...")
        
        response = client.models.generate_content(
            model=model_id,
            contents=[prompt],
            config={'response_mime_type': 'application/json'}
        )
        
        res = json.loads(response.text)
        print(f"  [AUDITOR DE SEGURANÇA] Veredito concluído: {res.get('classification')}")
        return {"final_verdict": res}
    except Exception as e:
        print(f"  [AUDITOR DE SEGURANÇA ERROR] {e}")
        return {"final_verdict": {"is_theft": False, "confidence": 0.0, "classification": "INOCENTADO", "error": str(e), "telegram_report": f"Falha na auditoria: {e}"}}

async def node_dispatcher(state: GraphState) -> Dict[str, Any]:
    event = state.get("event")
    if not event: return {}
    
    verdict = state.get("final_verdict")
    enable_fallback = state.get("enable_fallback", False)
    
    if not verdict or verdict.get("error"):
        if state.get("video_analysis") is None:
            # Filtrado localmente (Gatekeeper de Custos)
            verdict = {
                "is_theft": False,
                "confidence": 1.0,
                "suspect_description": "Filtrado localmente por baixo risco / sem itens de alto valor.",
                "telegram_report": "Evento filtrado pelo Gatekeeper de Custos local (baixo risco).",
                "products_stolen": [],
                "classification": "INOCENTADO"
            }
        else:
            # Auditor failed (either exception or offline)
            print("  [DISPATCHER] Falha na verificação com Gemini Cloud.")
            verdict = {
                "is_theft": False,
                "confidence": 0.0,
                "suspect_description": "Falha na verificação de IA (Gemini offline e fallback desabilitado).",
                "telegram_report": "O sistema não pôde confirmar a suspeita porque o serviço de verificação em nuvem está offline.",
                "products_stolen": [],
                "classification": "INOCENTADO"
            }
        
    classification = verdict.get("classification", "INOCENTADO")
    if classification == "FURTO_CONFIRMADO":
        status = "THEFT_CONFIRMED"
    elif classification == "SUSPEITO":
        status = "SUSPICIOUS"
    else:
        status = "CLEARED"
        
    ai_verdict = 1 if status in ("THEFT_CONFIRMED", "SUSPICIOUS") else 0
    confidence = verdict.get('confidence', 'N/A')
    telegram_report = verdict.get('telegram_report', 'N/A')
    suspect_desc = verdict.get('suspect_description', 'Não foi possível extrair a descrição física.')
    
    print(f"  [BRAIN] Resolution: {status} | Confidence: {confidence}")
    print(f"  [TELEGRAM ALERT] \n    🚨 STATUS: {status}\n    📝 {telegram_report}\n    👤 Suspeito: {suspect_desc}\n")
    
    try:
        original_payload = {}
        if event.payload_json:
            try: original_payload = json.loads(event.payload_json)
            except: pass
        merged_payload = {**original_payload, **verdict}
        
        async with aiosqlite.connect(QUEUE_DB_PATH) as db:
            await db.execute(
                "UPDATE events SET status = ?, ai_verdict = ?, payload_json = ? WHERE id = ?",
                (status, ai_verdict, json.dumps(merged_payload), event.id)
            )
            await db.commit()
            
        if status in ("THEFT_CONFIRMED", "SUSPICIOUS"):
            async with aiosqlite.connect(SYSTEM_DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute("SELECT key, value FROM config WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'camera_name')") as cursor:
                    rows = await cursor.fetchall()
                    config_dict = {row['key']: row['value'] for row in rows}
            
            bot_token = config_dict.get('telegram_bot_token') or os.getenv("TELEGRAM_BOT_TOKEN")
            chat_id = config_dict.get('telegram_chat_id') or os.getenv("TELEGRAM_CHAT_ID")
            camera_name = config_dict.get('camera_name') or "Câmera de Monitoramento"
            
            if bot_token and chat_id:
                event_datetime = original_payload.get('event_datetime', '')
                products_stolen = verdict.get('products_stolen', original_payload.get('products', []))
                products_str = ', '.join(products_stolen) if products_stolen else 'N/A'
                datetime_line = f"\n📅 <b>Data/Hora:</b> {event_datetime}" if event_datetime else ""
                products_line = f"\n📦 <b>Produtos:</b> {products_str}" if products_stolen else ""
                
                if status == "THEFT_CONFIRMED":
                    title_line = "🚨 <b>FURTO CONFIRMADO (ABORDAGEM DISCRETA)</b>"
                else:
                    title_line = "⚠️ <b>COMPORTAMENTO SUSPEITO (MONITORAR ATÉ O CAIXA)</b>"
                    
                msg = f"📍 <b>Câmera:</b> {camera_name}\n{title_line}{datetime_line}{products_line}\n\n📝 {telegram_report}\n\n👤 <b>Suspeito:</b> {suspect_desc}"
                print(f"  [TELEGRAM] Enviando alerta {status} para o grupo...")
                
                full_video_path = os.path.join(EVENT_STORAGE, event.video_path) if event.video_path else None
                asyncio.create_task(send_telegram_alert(bot_token, chat_id, msg, full_video_path))
            else:
                print(f"  [TELEGRAM] Credenciais nao configuradas (token/chat_id).")
                
    except Exception as e: print(f"  [BRAIN ERROR] Dispatcher: {e}")
    return {}

def should_continue(state: GraphState): return "contextualizer" if state.get("event") else END

def route_after_analyst(state: GraphState):
    event = state.get("event")
    if not event:
        return "dispatcher"
        
    dossier = state.get("biomechanical_dossier", {})
    products = dossier.get("products", [])
    
    payload = {}
    if event.payload_json:
        try:
            payload = json.loads(event.payload_json)
        except:
            pass
            
    suspicion_score = payload.get("suspicion_score", 0.0)
    
    # Check for high-value products keywords to escalate
    high_value_keywords = ["controle", "bebida", "carne", "celular", "premium", "copo", "garrafa"]
    has_high_value = any(any(kw in p.lower() for kw in high_value_keywords) for p in products)
    
    if suspicion_score >= 0.45 or has_high_value:
        print(f"  [GATEKEEPER] Evento {event.id} escalado para o Gemini Cloud (Score: {suspicion_score}, Produtos: {products})")
        return "video_investigator"
    else:
        print(f"  [GATEKEEPER] Evento {event.id} filtrado localmente para economizar custos de API (Score: {suspicion_score}, Produtos: {products})")
        return "dispatcher"

def build_graph():
    workflow = StateGraph(dict)
    workflow.add_node("poller", node_poller)
    workflow.add_node("contextualizer", node_contextualizer)
    workflow.add_node("biomechanical_analyst", node_biomechanical_analyst)
    workflow.add_node("video_investigator", node_video_investigator)
    workflow.add_node("security_auditor", node_security_auditor)
    workflow.add_node("dispatcher", node_dispatcher)
    
    workflow.set_entry_point("poller")
    
    workflow.add_conditional_edges(
        "poller", 
        should_continue, 
        {"contextualizer": "contextualizer", END: END}
    )
    
    workflow.add_edge("contextualizer", "biomechanical_analyst")
    
    # Conditional edge after Biomechanical Analyst (Gatekeeper de Faturamento)
    workflow.add_conditional_edges(
        "biomechanical_analyst",
        route_after_analyst,
        {"video_investigator": "video_investigator", "dispatcher": "dispatcher"}
    )
    
    workflow.add_edge("video_investigator", "security_auditor")
    workflow.add_edge("security_auditor", "dispatcher")
    workflow.add_edge("dispatcher", END)
    return workflow.compile()

app_graph = build_graph()

async def poll_exits():
    import time
    print("  [*] Escape Trajectory Dispatcher: Engaged.")
    while True:
        try:
            exit_events = []
            async with aiosqlite.connect(QUEUE_DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute("SELECT * FROM events WHERE status = 'PENDING_EXIT' ORDER BY id ASC LIMIT 20") as cursor:
                    rows = await cursor.fetchall()
                    exit_events = [dict(row) for row in rows]
            
            if not exit_events:
                await asyncio.sleep(2)
                continue
                
            for exit_event in exit_events:
                exit_id = exit_event['id']
                exit_payload = json.loads(exit_event['payload_json'])
                p_id = exit_payload.get('p_id')
                direction = exit_payload.get('direction')
                exit_time = exit_event['timestamp']
                
                # Look for matching theft event
                theft_row = None
                async with aiosqlite.connect(QUEUE_DB_PATH) as db:
                    db.row_factory = aiosqlite.Row
                    # Find the latest event for this p_id that is not PERSON_EXIT
                    query = """
                        SELECT * FROM events 
                        WHERE payload_json LIKE ? 
                          AND payload_json NOT LIKE '%"type": "PERSON_EXIT"%'
                        ORDER BY id DESC LIMIT 1
                    """
                    async with db.execute(query, (f'%"p_id": {p_id}%',)) as cursor:
                        theft_row = await cursor.fetchone()
                
                if theft_row:
                    theft_event = dict(theft_row)
                    theft_status = theft_event['status']
                    
                    if theft_status in ('THEFT_CONFIRMED', 'SUSPICIOUS'):
                        # Shoplifting confirmed! Send Telegram follow-up
                        async with aiosqlite.connect(SYSTEM_DB_PATH) as db:
                            db.row_factory = aiosqlite.Row
                            async with db.execute(
                                "SELECT key, value FROM config WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'route_left', 'route_right')"
                            ) as cursor:
                                rows = await cursor.fetchall()
                                config_dict = {r['key']: r['value'] for r in rows}
                        
                        bot_token = config_dict.get('telegram_bot_token') or os.getenv("TELEGRAM_BOT_TOKEN")
                        chat_id = config_dict.get('telegram_chat_id') or os.getenv("TELEGRAM_CHAT_ID")
                        
                        route_key = 'route_left' if direction == 'left' else 'route_right'
                        route_name = config_dict.get(route_key) or ("Esquerda" if direction == 'left' else "Direita")
                        
                        if bot_token and chat_id:
                            msg = f"🏃‍♂️ <b>Trajetória de Fuga:</b> O suspeito saiu da cena em direção a: <b>{route_name}</b>"
                            print(f"  [TELEGRAM] Enviando follow-up de fuga para P_{p_id}...")
                            asyncio.create_task(send_telegram_alert(bot_token, chat_id, msg))
                        
                        async with aiosqlite.connect(QUEUE_DB_PATH) as db:
                            await db.execute("UPDATE events SET status = 'COMPLETED' WHERE id = ?", (exit_id,))
                            await db.commit()
                            
                    elif theft_status == 'CLEARED':
                        # Shoplifting cleared, discard exit event
                        print(f"  [BRAIN] Furto inocentado para P_{p_id}, descartando rota de fuga.")
                        async with aiosqlite.connect(QUEUE_DB_PATH) as db:
                            await db.execute("UPDATE events SET status = 'CLEARED' WHERE id = ?", (exit_id,))
                            await db.commit()
                            
                    elif theft_status in ('PENDING', 'PROCESSING'):
                        # Theft is still being analyzed by Gemini. Skip for now.
                        continue
                else:
                    # No theft event found. If exit event is older than 180s, expire it.
                    if time.time() - exit_time > 180:
                        print(f"  [BRAIN] Evento de saída de P_{p_id} expirou sem furto correspondente.")
                        async with aiosqlite.connect(QUEUE_DB_PATH) as db:
                            await db.execute("UPDATE events SET status = 'EXPIRED' WHERE id = ?", (exit_id,))
                            await db.commit()
                    else:
                        # Skip for now and wait for matching theft event to appear
                        continue
            
            await asyncio.sleep(2)
        except Exception as e:
            print(f"  [BRAIN ERROR] poll_exits loop: {e}")
            await asyncio.sleep(2)

async def run_agent_loop():
    while True:
        try: await app_graph.ainvoke({"event": None})
        except Exception as e: print(f"  [LOOP ERROR] {e}")
        await asyncio.sleep(2)

async def run_agent():
    print("\n--- COGNITIVE BRAIN: ADAPTIVE V1 (GENAI 2.0+) ---")
    print("  [*] Model Auto-Discovery System: Engaged.")
    await asyncio.gather(
        run_agent_loop(),
        poll_exits()
    )

if __name__ == "__main__":
    try: asyncio.run(run_agent())
    except KeyboardInterrupt: pass
