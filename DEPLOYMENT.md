# Deployment Guide - Public Web Application

This guide covers deploying the Map Explorer as a **public web application** that others can access and use.

## Architecture

- **Frontend**: React + TypeScript + Vite (static build served via CDN/web server)
- **Backend**: FastAPI + TiTiler (API server, can be on same or different domain)

## Quick Deploy Options (Recommended for Public Access)

### Option 1: Vercel (Frontend) + Railway/Render (Backend) ⭐ Easiest

**Frontend on Vercel (Free tier available):**
1. Push code to GitHub
2. Go to [vercel.com](https://vercel.com), import your repo
3. Set environment variable: `VITE_API_URL=https://your-backend.railway.app`
4. Deploy (automatic on every push)

**Backend on Railway (Free tier available):**
1. Go to [railway.app](https://railway.app), create new project
2. Connect GitHub repo, select `backend/` directory
3. Set environment variables in Railway dashboard
4. Railway auto-detects FastAPI and deploys
5. Copy the public URL to use as `VITE_API_URL`

### Option 2: Netlify (Frontend) + Render (Backend) ⭐ Also Easy

**Frontend on Netlify:**
1. Push to GitHub
2. Go to [netlify.com](https://netlify.com), "Add new site" → "Import from Git"
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add environment variable: `VITE_API_URL=https://your-backend.onrender.com`

**Backend on Render:**
1. Go to [render.com](https://render.com), create new Web Service
2. Connect GitHub, select `backend/` directory
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn app:app --host 0.0.0.0 --port $PORT`
5. Set environment variables in Render dashboard
6. Copy the public URL

### Option 3: All-in-One on Fly.io or DigitalOcean App Platform

**Fly.io (Good for full-stack):**
1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. `fly launch` in project root
3. Configure `fly.toml` for both frontend and backend
4. Deploy: `fly deploy`

**DigitalOcean App Platform:**
1. Go to DigitalOcean → App Platform
2. Connect GitHub repo
3. Add frontend component (build: `npm run build`, output: `dist`)
4. Add backend component (run: `uvicorn app:app`)
5. Set environment variables
6. Deploy

## Step-by-Step: Deploy to Vercel + Railway (Recommended)

### Step 1: Prepare Your Code

1. **Ensure all changes are committed:**
```bash
git add .
git commit -m "Prepare for deployment"
git push origin main
```

2. **Create `.env.production` for reference:**
```bash
VITE_API_URL=https://your-backend-url.railway.app
```

### Step 2: Deploy Backend to Railway

1. Go to [railway.app](https://railway.app) and sign up/login
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository
4. Railway will detect the project - click "Add Service" → "GitHub Repo"
5. In the service settings:
   - **Root Directory**: Set to `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app:app --host 0.0.0.0 --port $PORT`
6. Go to "Variables" tab and add:
   ```
   PREDICTIONS_BASE_URL=your-s3-url
   PREDICTIONS_PATH_TEMPLATE={zone}-{year}/{tile}/RH{rh}_Q{q}.tif
   PC_API_KEY=your-key (if needed)
   ```
7. Click "Settings" → "Generate Domain" to get public URL
8. **Copy the public URL** (e.g., `https://map-explorer-backend.railway.app`)

### Step 3: Deploy Frontend to Vercel

1. Go to [vercel.com](https://vercel.com) and sign up/login
2. Click "Add New Project" → Import your GitHub repository
3. Configure:
   - **Framework Preset**: Vite
   - **Root Directory**: `./` (root)
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
4. Go to "Environment Variables" and add:
   ```
   VITE_API_URL=https://your-backend-url.railway.app
   ```
   (Use the Railway URL from Step 2)
5. Click "Deploy"
6. Vercel will give you a URL like `https://map-explorer.vercel.app`

### Step 4: Update CORS in Backend

Update `backend/app.py` to allow your Vercel domain:

```python
origins = [
    "https://map-explorer.vercel.app",  # Your Vercel URL
    "https://*.vercel.app",  # All Vercel previews
    "http://localhost:5173",  # Keep for local dev
]
```

Commit and push - Railway will auto-redeploy.

### Step 5: Test Your Public App

Visit your Vercel URL - the app should be live and accessible to anyone!

## Alternative: Deploy Everything to Render (Free Tier)

### Backend on Render

1. Go to [render.com](https://render.com), sign up
2. "New" → "Web Service"
3. Connect GitHub, select repo
4. Configure:
   - **Name**: `map-explorer-backend`
   - **Root Directory**: `backend`
   - **Environment**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app:app --host 0.0.0.0 --port $PORT`
5. Add environment variables
6. Click "Create Web Service"
7. Copy the URL (e.g., `https://map-explorer-backend.onrender.com`)

### Frontend on Render

1. "New" → "Static Site"
2. Connect GitHub repo
3. Configure:
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `dist`
4. Add environment variable:
   - **Key**: `VITE_API_URL`
   - **Value**: Your backend Render URL
5. Deploy

**Note**: Render free tier spins down after inactivity (15 min), causing cold starts.

## Environment Variables

### Frontend

Create a `.env` file in the root directory (copy from `env.example`):

```bash
cp env.example .env
```

Edit `.env` and set:
```bash
VITE_API_URL=http://localhost:8006
```

For production, set this to your backend URL:
```bash
VITE_API_URL=https://your-backend-domain.com
```

**Note:** The frontend code has been updated to use environment variables. All API calls now use `VITE_API_URL` from the config.

### Backend

Set these environment variables:

```bash
# Required for predictions
PREDICTIONS_BASE_URL=https://your-s3-bucket.com/predictions
PREDICTIONS_PATH_TEMPLATE={zone}-{year}/{tile}/RH{rh}_Q{q}.tif

# Optional: Planetary Computer API key for Sentinel-2
PC_API_KEY=your-api-key-here
```

## Local Development

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8006 --reload
```

Or use the run script:
```bash
python run.py
```

### Frontend

```bash
npm install
npm run dev
```

The app will be available at `http://localhost:5173`

## Production Deployment

### Option 1: Separate Frontend and Backend

#### Backend Deployment

1. **Using uvicorn directly:**
```bash
cd backend
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8006
```

2. **Using gunicorn (recommended for production):**
```bash
pip install gunicorn
gunicorn app:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8006
```

3. **Using Docker:**
```bash
docker build -t map-explorer-backend -f Dockerfile.backend .
docker run -p 8006:8006 -e PREDICTIONS_BASE_URL=... map-explorer-backend
```

#### Frontend Deployment

1. **Build the frontend:**
```bash
npm run build
```

This creates a `dist/` directory with static files.

2. **Serve with a web server:**

   - **Nginx:**
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       root /path/to/map-explorer/dist;
       index index.html;

       location / {
           try_files $uri $uri/ /index.html;
       }
   }
   ```

   - **Apache:**
   ```apache
   <VirtualHost *:80>
       ServerName your-domain.com
       DocumentRoot /path/to/map-explorer/dist

       <Directory /path/to/map-explorer/dist>
           Options -Indexes +FollowSymLinks
           AllowOverride All
           Require all granted
       </Directory>
   </VirtualHost>
   ```

   - **Python simple server (for testing):**
   ```bash
   cd dist
   python -m http.server 8080
   ```

3. **Deploy to static hosting:**
   - **Vercel:** `vercel --prod`
   - **Netlify:** `netlify deploy --prod`
   - **GitHub Pages:** See GitHub Actions example below

### Option 2: Docker Compose (Recommended)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "8006:8006"
    environment:
      - PREDICTIONS_BASE_URL=${PREDICTIONS_BASE_URL}
      - PREDICTIONS_PATH_TEMPLATE=${PREDICTIONS_PATH_TEMPLATE}
      - PC_API_KEY=${PC_API_KEY}
    volumes:
      - ./backend:/app
    restart: unless-stopped

  frontend:
    build:
      context: .
      dockerfile: Dockerfile.frontend
    ports:
      - "80:80"
    environment:
      - VITE_API_URL=http://backend:8006
    depends_on:
      - backend
    restart: unless-stopped
```

Run with:
```bash
docker-compose up -d
```

### Option 3: Cloud Platforms

#### Backend (FastAPI)

- **Heroku:** Use `Procfile` with `web: uvicorn app:app --host 0.0.0.0 --port $PORT`
- **Railway:** Auto-detects FastAPI, set environment variables in dashboard
- **Render:** Connect GitHub repo, set build command and start command
- **AWS/GCP/Azure:** Use container services (ECS, Cloud Run, Container Instances)

#### Frontend (Static)

- **Vercel:** `vercel --prod`
- **Netlify:** `netlify deploy --prod`
- **Cloudflare Pages:** Connect GitHub repo
- **AWS S3 + CloudFront:** Upload `dist/` to S3, serve via CloudFront

## Important Configuration for Public Deployment

### 1. CORS Settings (Critical!)

Update `backend/app.py` to allow your frontend domain:

```python
origins = [
    "https://your-app.vercel.app",  # Your production frontend URL
    "https://*.vercel.app",  # Vercel preview deployments
    "http://localhost:5173",  # Keep for local dev
    "http://localhost:3000",  # Common dev port
]
```

**Important**: Without this, users will get CORS errors when the frontend tries to call the backend.

### 2. Environment Variables

**Frontend** (set in Vercel/Netlify/Render dashboard):
```
VITE_API_URL=https://your-backend-url.railway.app
```

**Backend** (set in Railway/Render dashboard):
```
PREDICTIONS_BASE_URL=your-s3-bucket-url
PREDICTIONS_PATH_TEMPLATE={zone}-{year}/{tile}/RH{rh}_Q{q}.tif
PC_API_KEY=your-planetary-computer-key (optional)
```

### 3. Security Considerations

- ✅ **HTTPS**: All platforms provide HTTPS automatically
- ✅ **CORS**: Configured to only allow your frontend domain
- ⚠️ **API Keys**: Never commit API keys - use environment variables
- ⚠️ **Rate Limiting**: Consider adding rate limiting to backend for public use
- ⚠️ **Authentication**: Add user authentication if needed (not included by default)

## Quick Start with Docker

The easiest way to deploy is using Docker Compose:

```bash
# 1. Copy environment file
cp env.example .env

# 2. Edit .env and set your backend URL
# VITE_API_URL=http://localhost:8006  # or your production URL

# 3. Set backend environment variables (optional)
export PREDICTIONS_BASE_URL=...
export PC_API_KEY=...

# 4. Build and run
docker-compose up -d

# Frontend will be at http://localhost
# Backend will be at http://localhost:8006
```

## Environment Variables Configuration

✅ **The frontend has been updated to use environment variables automatically.**

All API calls now use `VITE_API_URL` from the config file (`src/config.ts`). No code changes needed - just set the environment variable.

## Security Considerations

1. **Never commit API keys** - Use environment variables
2. **Use HTTPS** in production
3. **Configure CORS** properly for your domain
4. **Rate limiting** - Consider adding rate limiting to the backend
5. **Authentication** - Add authentication if the app will be public

## Custom Domain (Optional)

### Vercel Custom Domain

1. Go to your Vercel project → Settings → Domains
2. Add your domain (e.g., `map-explorer.com`)
3. Follow DNS instructions (add CNAME record)
4. Vercel handles SSL automatically

### Railway Custom Domain

1. Go to Railway project → Settings → Networking
2. Add custom domain
3. Update DNS records as instructed
4. Railway provides SSL certificate

## Monitoring & Analytics

### Backend Monitoring

Add a health check endpoint in `backend/app.py`:

```python
@app.get("/health")
async def health():
    return {"status": "ok", "service": "map-explorer-backend"}
```

Monitor in:
- **Railway**: Built-in metrics dashboard
- **Render**: Built-in metrics
- **Vercel**: Analytics dashboard

### Frontend Error Tracking

Add Sentry for error tracking:

```bash
npm install @sentry/react
```

Configure in `src/main.tsx`:
```typescript
import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "your-sentry-dsn",
  environment: import.meta.env.MODE,
});
```

## Cost Estimates

### Free Tier Options:
- **Vercel**: Free for personal projects (generous limits)
- **Netlify**: Free tier available
- **Railway**: $5/month free credit (usually enough for small apps)
- **Render**: Free tier (with limitations - spins down after inactivity)

### Paid Options (if you need more):
- **Vercel Pro**: $20/month (for teams)
- **Railway**: Pay-as-you-go after free credit
- **DigitalOcean**: $5-12/month for basic app
- **AWS/GCP**: Pay-as-you-go (can be expensive)

**Recommendation**: Start with Vercel + Railway free tiers, upgrade if needed.

## Troubleshooting

- **CORS errors:** Check backend CORS origins configuration
- **API not found:** Verify `VITE_API_URL` is set correctly
- **Tiles not loading:** Check backend is accessible and TiTiler is working
- **Build errors:** Ensure all dependencies are installed

