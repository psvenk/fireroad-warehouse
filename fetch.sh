#!/bin/sh

if [ -z "$1" ]
then
	echo "No subject ID supplied"
	exit
fi

ORACLE_HOME="$HOME/docs/warehouse/instantclient_21_9/"
. "$ORACLE_HOME/warehouse_creds"

LD_LIBRARY_PATH="$ORACLE_HOME" "$ORACLE_HOME/sqlplus" "$USERNAME/$PASSWORD@warehouse" <<EOF
SET LINESIZE 20000;
SELECT * FROM (
	SELECT * FROM subject_offered
	WHERE subject_id='$1' AND is_master_section='Y'
	ORDER BY term_code DESC
) WHERE ROWNUM <= 1;
EXIT;
EOF
# FIXME: vulnerable to SQL injection
