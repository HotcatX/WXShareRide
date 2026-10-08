UPDATE users
SET name='用户 '||upper(substr(md5(id::text),1,8)), updated_at=clock_timestamp()
WHERE name~'^[[:space:]]*$';
