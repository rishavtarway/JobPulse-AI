# Restart node server to apply prompt and endpoint fixes
npm run form-filler &
pid=$!
sleep 2
curl -s http://127.0.0.1:3001/api/form-filler/cache
kill $pid
