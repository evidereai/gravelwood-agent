# Gravelwood AI Sales Agent

AI-powered voice sales agent for Gravelwood Car Sales. When a customer submits an enquiry, the app searches the Gravelwood website for the relevant car, briefs the AI agent with full vehicle details, and connects the customer to a live voice/text conversation.

---

## How It Works

1. Customer submits name + car interest via the enquiry form
2. The backend calls Claude with web search to find the exact car on gravelwood.co.uk
3. All vehicle details are extracted and used to brief the AI agent
4. Customer is connected to an AI voice call — the agent answers questions about that specific car
5. At the end of the call, a structured lead summary is generated for the sales team

---

## Project Structure

```
gravelwood-agent/
├── server.js          ← Express backend + Claude API integration
├── package.json
├── .env.example       ← Copy to .env for local development
└── public/
    └── index.html     ← Frontend (served as static file)
```

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Set your API key
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# 3. Run locally
npm start
# → http://localhost:3000
```

---

## Deploy to Azure App Service

### Option A — Azure Portal (easiest)

1. Go to portal.azure.com → Create a resource → Web App
2. Settings:
   - **Runtime**: Node 18 LTS
   - **OS**: Linux
   - **Plan**: Free F1 (for testing) or B1 (for production)
3. Once created, go to **Deployment Center** → choose your source (zip deploy or GitHub)
4. Go to **Configuration → Application Settings** → add:
   - `ANTHROPIC_API_KEY` = your key
   - `WEBSITE_NODE_DEFAULT_VERSION` = 18-lts

### Option B — Azure CLI

```bash
# Login
az login

# Create resource group
az group create --name gravelwood-rg --location uksouth

# Create app service plan
az appservice plan create --name gravelwood-plan --resource-group gravelwood-rg --sku B1 --is-linux

# Create web app
az webapp create --name gravelwood-agent --resource-group gravelwood-rg --plan gravelwood-plan --runtime "NODE:18-lts"

# Set API key
az webapp config appsettings set --name gravelwood-agent --resource-group gravelwood-rg --settings ANTHROPIC_API_KEY="your_key_here"

# Deploy (from project root)
zip -r app.zip . --exclude ".git/*" --exclude "node_modules/*"
az webapp deployment source config-zip --name gravelwood-agent --resource-group gravelwood-rg --src app.zip
```

### After Deployment

Your app will be live at: `https://gravelwood-agent.azurewebsites.net`

---

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key from console.anthropic.com |
| `PORT` | Port (Azure sets this automatically) |

---

## Voice Support

- **Text-to-speech**: Works in all modern browsers via Web Speech API
- **Speech recognition (microphone)**: Requires HTTPS — works automatically on Azure (which uses HTTPS by default). Will not work on plain HTTP localhost.
- **Supported browsers**: Chrome, Edge, Safari. Firefox has limited Web Speech API support.

---

## Production Notes

- The web search used to find car details costs a small amount of API credits per enquiry (~$0.01–0.02)
- Conversation messages also consume tokens — typical short call costs ~$0.02–0.05
- In a real deployment, replace the web search with a direct API into the dealer's inventory management system (Dragon2000, Vehiso, etc.)
