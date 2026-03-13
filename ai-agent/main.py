"""
VideoSDK AI Voice Agent for Invisible CRM
==========================================
This agent handles real-time voice conversations with leads over the phone.
Uses VideoSDK's AI Agent SDK + Google Gemini for natural speech-to-speech.

Architecture:
  - Runs as a Worker that registers with VideoSDK cloud
  - When an outbound call is routed to it (via SIP gateway + routing rules),
    the entrypoint creates an Agent + Pipeline with Gemini Realtime LLM
  - Gemini handles the actual voice conversation in real-time
  - On call end, sends transcript + summary to the Node.js backend

Usage:
  cd ai-agent
  source venv/bin/activate
  python main.py
"""

import os
import json
import asyncio
import logging
from datetime import datetime

import requests
from dotenv import load_dotenv

from videosdk.agents import (
    Agent,
    AgentSession,
    Pipeline,
    Worker,
    WorkerOptions,
    WorkerType,
    JobContext,
)
from videosdk.plugins.google import GeminiRealtime, GeminiLiveConfig

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("crm-ai-agent")

# ——— Configuration ———
VIDEOSDK_AUTH_TOKEN = os.getenv("VIDEOSDK_AUTH_TOKEN", "")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
BACKEND_WEBHOOK_URL = os.getenv(
    "BACKEND_WEBHOOK_URL", "http://localhost:3000/api/calls/agent-webhook"
)

if not VIDEOSDK_AUTH_TOKEN:
    raise ValueError("VIDEOSDK_AUTH_TOKEN is required — get it from https://app.videosdk.live")
if not GOOGLE_API_KEY:
    raise ValueError("GOOGLE_API_KEY is required for Gemini.")

# ——— System Prompt ———
SYSTEM_PROMPT = """You are a friendly, professional AI sales assistant making an outbound phone call to a potential customer on behalf of our team.

RULES:
- Be warm, empathetic, professional, and conversational
- Keep responses concise (2-3 sentences max) — this is a phone call
- Listen actively and ask relevant follow-up questions
- Understand the customer's needs and take notes mentally
- If they mention a specific problem, acknowledge it and explain how you can help
- Do NOT make unrealistic promises or commitments
- If you cannot answer something, say the team will follow up with details
- If the customer seems uninterested or busy, wrap up gracefully
- Sound natural like a real person, not robotic or scripted
- If they ask who you are, say you're an AI assistant calling on behalf of the team

Start by greeting them warmly and referencing what they inquired about. Ask how you can help."""


async def entrypoint(ctx: JobContext):
    """
    Called by the Worker when a call is routed to this agent.
    Sets up the Agent + Pipeline + Session for real-time voice conversation.
    """
    logger.info(f"Call received — room: {ctx.room.id if ctx.room else 'unknown'}")

    call_start_time = datetime.utcnow()
    call_metadata = {}

    # Try to extract lead context from the participant metadata
    try:
        if ctx.room and hasattr(ctx.room, 'metadata') and ctx.room.metadata:
            meta = ctx.room.metadata
            if isinstance(meta, str):
                call_metadata = json.loads(meta)
            elif isinstance(meta, dict):
                call_metadata = meta
            logger.info(f"Lead context: {call_metadata.get('leadName', 'Unknown')}")
    except Exception as e:
        logger.warning(f"Could not load call metadata: {e}")

    # Build personalized instructions
    lead_name = call_metadata.get("leadName", "there")
    lead_inquiry = call_metadata.get("leadInquiry", "your inquiry")
    lead_summary = call_metadata.get("leadAiSummary", "")

    instructions = SYSTEM_PROMPT
    if lead_name or lead_inquiry:
        context = f"\n\nCONTEXT ABOUT THIS LEAD:\nName: {lead_name}\nInquiry: {lead_inquiry}"
        if lead_summary:
            context += f"\nBackground: {lead_summary}"
        instructions += context

    # Create the Agent
    agent = Agent(instructions=instructions)

    # Create the Pipeline with Gemini Realtime (speech-to-speech)
    pipeline = Pipeline(
        llm=GeminiRealtime(
            model="gemini-2.0-flash-live",
            config=GeminiLiveConfig(
                voice="Puck",
                language_code="en-US",
            ),
            google_api_key=GOOGLE_API_KEY,
        ),
    )

    # Create and start the session
    session = AgentSession(agent=agent, pipeline=pipeline)

    @agent.on("on_enter")
    async def on_agent_enter():
        logger.info("Agent entered the call room — conversation starting")

    @agent.on("on_exit")
    async def on_agent_exit():
        call_end_time = datetime.utcnow()
        duration = int((call_end_time - call_start_time).total_seconds())

        logger.info(f"Call ended. Duration: {duration}s")

        # Send results to the Node.js backend webhook
        try:
            payload = {
                "callLogId": call_metadata.get("callLogId", ""),
                "leadId": call_metadata.get("leadId", ""),
                "roomId": ctx.room.id if ctx.room else "",
                "durationSeconds": duration,
                "transcript": "",  # Gemini handles this internally
                "turnCount": 0,
            }

            logger.info(f"Posting call results to: {BACKEND_WEBHOOK_URL}")
            resp = requests.post(
                BACKEND_WEBHOOK_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=10,
            )
            logger.info(f"Backend response: {resp.status_code}")
        except Exception as e:
            logger.error(f"Failed to post call results: {e}")

    await session.start(ctx)
    logger.info("Agent session started — waiting for conversation")


def main():
    """Start the VideoSDK Worker that listens for incoming calls."""
    logger.info("Starting CRM AI Voice Agent Worker...")
    logger.info(f"Backend webhook URL: {BACKEND_WEBHOOK_URL}")

    options = WorkerOptions(
        entrypoint_fnc=entrypoint,
        agent_id="CRMVoiceAgent",
        auth_token=VIDEOSDK_AUTH_TOKEN,
        worker_type=WorkerType.ROOM,
        port=8089,
    )

    logger.info("Worker registered. Waiting for incoming calls...")
    Worker.run_worker(options)


if __name__ == "__main__":
    main()
