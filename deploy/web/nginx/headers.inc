# 每个自己写了 add_header 的 location 都要 include 这个文件（nginx 里 location 一旦有自己的 add_header，就不再继承外层的）
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
# $pling_hsts：HTTPS 模式是 max-age=…，HTTP 模式是空（空值不会发出去）
add_header Strict-Transport-Security $pling_hsts always;
