from pydantic import BaseModel
from typing import List, Optional, Any

class Point(BaseModel):
    x: float
    y: float

class Zone(BaseModel):
    id: Optional[int] = None
    name: str
    polygon: List[Point]

class Event(BaseModel):
    id: Optional[int] = None
    timestamp: float
    video_path: str
    status: str = "PENDING"
    ai_verdict: Optional[bool] = None
    ai_summary: Optional[str] = None
    telegram_message_id: Optional[str] = None
    payload_json: Optional[str] = None

class SystemConfig(BaseModel):
    gemini_api_key: Optional[str] = None
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    brain_rules: Optional[str] = None
