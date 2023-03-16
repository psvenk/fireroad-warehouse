# fireroad-warehouse

A work-in-progress FireRoad-compatible client for MIT's [Data Warehouse][1],
intended to replace at least part of FireRoad's scraper when finished.

[1]: https://ist.mit.edu/warehouse

## Obtaining Data Warehouse access

In order to use this, you will need credentials to access MIT's Data Warehouse.
Here are steps for setting that up (on Linux x86-64; details may vary on other
platforms):

1. Request access to subject enrollment data using [this form][2]; specifically,
   access to the tables `CIS_COURSE_CATALOG`, `SUBJECT_OFFERED`, and
   `CIS_HASS_ATTRIBUTE` is needed.
2. Once access has been granted, [set a password][3] for your Data Warehouse
   account.
3. Download both the "Basic" and "SQL\*Plus" packages (as zip files) for Oracle
   Instant Client from [Oracle's website][4].
4. Extract both zip files; they should both create files in a new directory
   called `instantclient_21_9`.
5. Download the MIT Oracle configuration files from [the MIT knowledge base
   entry][5]. Extract the zip file, move `ldap.ora` and `sqlnet.ora` to
   `instantclient_21_9/network/admin/`, and add a crypto seed to `sqlnet.ora` as
   instructed in the knowledge base article.
6. Now, if `$ORACLE_HOME` is set to the full path of your `instantclient_21_9`
   directory and `$USERNAME` and `$PASSWORD` are set to your Data Warehouse
   credentials, you should be able to run SQL\*Plus with one of the following
   command lines (the second gives you Readline-style editing, including keeping
   a history file under `/tmp/`):
   ```console
   $ LD_LIBRARY_PATH="$ORACLE_HOME" "$ORACLE_HOME/sqlplus" "$USERNAME/$PASSWORD@warehouse"
   $ LD_LIBRARY_PATH="$ORACLE_HOME" rlwrap -H /tmp/sqlplus_hist "$ORACLE_HOME/sqlplus" "$USERNAME/$PASSWORD@warehouse"
   ```
7. To be able to run `fetch.sh`, set `$ORACLE_HOME` appropriately in `fetch.sh`
   and create a file `$ORACLE_HOME/warehouse_creds` of the following form:
   ```sh
   USERNAME=yourusernamehere
   PASSWORD=yourpasswordhere
   ```

[2]: https://ist.mit.edu/business/warehouse/access
[3]: https://warehouse-web.mit.edu/cgi-bin/change_pw.cgi
[4]: https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html
[5]: http://kb.mit.edu/confluence/display/istcontrib/Manual+Oracle+11gR2+Installation#ManualOracle11gR2Installation-IMPORTANTInstalltheMITOracleConfigurationFiles

## Usage

`./fetch.sh 6.1220`

This is only a prototype and will be replaced by a more robust script in a
different language.

<!-- vim: set tw=80: -->
