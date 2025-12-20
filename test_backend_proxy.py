#!/usr/bin/env python3
"""
Test script to verify the backend proxy works for CORS issues.
"""

import requests
import json

def test_backend_proxy():
    """Test the backend proxy endpoint for CORS bypass."""
    
    # Test URL that has CORS issues
    test_url = "https://sid.erda.dk/share_redirect/hctRlt60a7/deploy_status/deploy_status.geojson"
    
    print("Testing Backend Proxy for CORS Fix")
    print("=" * 50)
    print(f"Test URL: {test_url}")
    print()
    
    try:
        # Test backend proxy
        print("1. Testing backend proxy endpoint...")
        response = requests.post(
            "http://localhost:8000/geojson/proxy",
            json={"url": test_url},
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            
            if "error" in data:
                print(f"❌ Proxy returned error: {data['error']}")
                return False
            
            print("✅ Proxy request successful!")
            print(f"   Type: {data.get('type', 'Unknown')}")
            print(f"   Features: {len(data.get('features', []))}")
            
            if data.get('features'):
                first_feature = data['features'][0]
                print(f"   First feature geometry: {first_feature.get('geometry', {}).get('type', 'Unknown')}")
                print(f"   First feature properties: {len(first_feature.get('properties', {}))}")
            
            return True
            
        else:
            print(f"❌ Proxy request failed: HTTP {response.status_code}")
            print(f"   Response: {response.text}")
            return False
            
    except requests.exceptions.ConnectionError:
        print("❌ Backend not running!")
        print("   Start with: cd backend && uvicorn app:app --reload --port 8000")
        return False
    except Exception as e:
        print(f"❌ Test error: {e}")
        return False

def test_direct_fetch():
    """Test direct fetch to confirm CORS issue."""
    
    test_url = "https://sid.erda.dk/share_redirect/hctRlt60a7/deploy_status/deploy_status.geojson"
    
    print("2. Testing direct fetch (should fail with CORS)...")
    try:
        response = requests.get(test_url, timeout=10)
        print(f"✅ Direct fetch successful: HTTP {response.status_code}")
        return True
    except Exception as e:
        print(f"❌ Direct fetch failed (expected): {e}")
        return False

if __name__ == "__main__":
    print("Backend Proxy CORS Fix Test")
    print("=" * 50)
    
    # Test direct fetch first
    direct_success = test_direct_fetch()
    print()
    
    # Test proxy
    proxy_success = test_backend_proxy()
    
    print("\n" + "=" * 50)
    print("Results:")
    print(f"Direct fetch: {'✅ Success' if direct_success else '❌ Failed (expected)'}")
    print(f"Proxy fetch: {'✅ Success' if proxy_success else '❌ Failed'}")
    
    if proxy_success:
        print("\n🎉 Backend proxy is working! CORS issue resolved.")
        print("\nNext steps:")
        print("1. Start the frontend: npm run dev")
        print("2. Try loading the problematic URL in the sidebar")
        print("3. The system will automatically use the proxy if direct fetch fails")
    else:
        print("\n❌ Backend proxy needs attention.")
        print("Make sure:")
        print("1. Backend is running on port 8000")
        print("2. All dependencies are installed: pip install -r backend/requirements.txt")
        print("3. Check backend logs for errors")
