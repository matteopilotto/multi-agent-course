import os
import anthropic
from dotenv import load_dotenv

def get_current_location():
    return "Milan"

def get_weather(location):
    return "18°C, light rain"

def invoke_tools(response):
    tool_results = []
    for block in response.content:
        if block.type == "tool_use":
            output = TOOL_FUNCTIONS[block.name](**block.input)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output
            })
    
    return {"role": "user", "content": tool_results}

TOOLS = [
    {
        "name": "get_weather",
        "description": "Get the current weather for a location. Returns temperature in Celsius and conditions (e.g. 'light rain').",
        "input_schema": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City name, e.g. 'Milan'"
                }
            },
            "required": ["location"]
        }
    },
    {
        "name": "get_current_location",
        "description": "Returns the name of the city corresponding to the current location",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": []
        },
    }
]

TOOL_FUNCTIONS = {
    "get_current_location": get_current_location,
    "get_weather": get_weather,
}

load_dotenv()
client = anthropic.Anthropic()

messages = [
    {
        "role": "user",
        "content": "What's the weather and should I bring an umbrella"
    }
]

while True:
    response = client.messages.create(
        model="claude-sonnet-5",
        max_tokens=1024,
        tools=TOOLS,
        messages=messages
    )

    print(response.stop_reason)
    print(response.content)

    if response.stop_reason == "end_turn":
        break

    tool_results = invoke_tools(response)
    messages.append({"role": "assistant", "content": response.content})
    if tool_results:
        messages.append(tool_results)



