import os
import sys

import oracledb

username = os.environ.get("WAREHOUSE_USERNAME")
password = os.environ.get("WAREHOUSE_PASSWORD")

if username is None or password is None:
    print("WAREHOUSE_USERNAME and/or WAREHOUSE_PASSWORD not provided")
    exit(1)
elif "/" in username:
    print("WAREHOUSE_USERNAME contains forbidden character '/'")
    exit(1)
elif "@" in password:
    print("WAREHOUSE_PASSWORD contains forbidden character '@'")
    exit(1)

# We need to use a DSN instead of supplying username, password, service_name
# because we are using LDAP instead of a tsnames.ora file
dsn = f"{username}/{password}@warehouse"

# We also need to use the "thick" mode so that ldap.ora and sqlplus.ora are
# read
oracledb.init_oracle_client()

try:
    subject = sys.argv[1]
except IndexError:
    print(f"Usage: {sys.argv[0]} <subject>")
    exit(1)

with oracledb.connect(dsn) as connection:
    with connection.cursor() as cursor:
        cursor.execute("""
            SELECT * FROM subject_offered
            WHERE subject_id=:subject AND is_master_section='Y'
            ORDER BY term_code DESC
        """, subject=subject)

        # Return results as dict
        columns = [col[0] for col in cursor.description]
        cursor.rowfactory = lambda *args: dict(zip(columns, args))

        for row in cursor.fetchmany(2):
            print(row)
