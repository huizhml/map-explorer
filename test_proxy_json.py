#!/usr/bin/env python3
"""
Test script to verify the backend proxy fix.
"""

import requests
import json

def test_proxy_with_json_body():
    """Test the proxy endpoint with JSON body."""
    
    print("Testing Backend Proxy with JSON Body")
    print("=" * 50)
    
    # Test URL that has CORS issues
    test_url = "https://sid.erda.dk/share_redirect/hctRlt60a7/deploy_status/deploy_status.geojson"
    
    try:
        print(f"Testing URL: {test_url}")
        print()
        
        # Test backend proxy with JSON body
        response = requests.post(
            "http://localhost:8006/geojson/proxy",
            json={"url": test_url},
            timeout=30
        )
        
        print(f"Status Code: {response.status_code}")
        print(f"Headers: {dict(response.headers)}")
        
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
        print("   Start with: cd backend && uvicorn app:app --reload --port 8006")
        return False
    except Exception as e:
        print(f"❌ Test error: {e}")
        return False

if __name__ == "__main__":
    print("Backend Proxy JSON Body Test")
    print("=" * 50)
    
    success = test_proxy_with_json_body()
    
    print("\n" + "=" * 50)
    print("Result:")
    print(f"Proxy with JSON body: {'✅ Success' if success else '❌ Failed'}")
    
    if success:
        print("\n🎉 Backend proxy is working with JSON body!")
        print("\nNext steps:")
        print("1. Restart the backend: cd backend && uvicorn app:app --reload --port 8006")
        print("2. Try loading GeoJSON in the frontend")
        print("3. The proxy should now work without 422 errors")
    else:
        print("\n❌ Backend proxy needs attention.")
        print("Make sure:")
        print("1. Backend is running on port 8006")
        print("2. Pydantic BaseModel is properly imported")
        print("3. Check backend logs for errors")
