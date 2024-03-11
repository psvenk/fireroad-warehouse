# fireroad-warehouse

A work-in-progress FireRoad-compatible API using MIT's [Data Warehouse][1],
intended to replace at least part of FireRoad's scraper when finished.

[1]: https://ist.mit.edu/warehouse

## Obtaining Data Warehouse access, and setup

In order to use this, you will need credentials to access MIT's Data Warehouse.
Here are steps for setting that up (on Linux or macOS x86-64; details
may vary on other platforms):

1. Request access to subject enrollment data using [this form][2]; specifically,
   access to the tables `CIS_COURSE_CATALOG`, `SUBJECT_OFFERED`, and
   `CIS_HASS_ATTRIBUTE` is needed.
2. Once access has been granted, [set a password][3] for your Data Warehouse
   account.
3. Download both the "Basic" and "SQL\*Plus" packages (as zip files) for Oracle
   Instant Client from [Oracle's website][4].
   - As of the time of writing, MIT's Data Warehouse uses Oracle Database 10.2;
     consult [the `python-oracledb` documentation][5] for information about the
     versions of Instant Client that work. Typically, an Instant Client a few
     versions later than what is officially supported should work fine.
   - Modern versions of `node-oracledb` have a "thin mode" that does not
     require the Instant Client to be installed, but as of the time of writing,
     the version of Oracle Database used by MIT is both too old to support it,
     and uses a proprietary encryption scheme that the thin client does not
     implement.
4. Extract both zip files; they should both create files in a new directory
   called `instantclient_21_9`.
5. Now, if `$ORACLE_HOME` is set to the full path of your `instantclient_21_9`
   directory and `$user` and `$pass` are set to your Data Warehouse credentials,
   you should be able to run SQL\*Plus with one of the following command lines
   (the second gives you Readline-style editing, including keeping a history
   file under `/tmp/`):
   ```console
   $ LD_LIBRARY_PATH="$ORACLE_HOME" "$ORACLE_HOME/sqlplus" "$user/$pass@warehouse"
   $ LD_LIBRARY_PATH="$ORACLE_HOME" rlwrap -H /tmp/sqlplus_hist "$ORACLE_HOME/sqlplus" "$user/$pass@warehouse"
   ```
6. To be able to run the script, create a file `.env` at the root of this
   repository with the following contents:
   ```sh
   ORACLE_HOME="/path/to/instantclient_21_9"
   USERNAME=yourusernamehere
   PASSWORD=yourpasswordhere
   ```

[2]: https://ist.mit.edu/business/warehouse/access
[3]: https://warehouse-web.mit.edu/cgi-bin/change_pw.cgi
[4]: https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html
[5]: https://python-oracledb.readthedocs.io/en/latest/user_guide/installation.html#supported-oracle-database-versions

### Running on macOS ARM
Oracle has not created an Instant Client distributable for macOS ARM
architectures (e.g M1) as of yet. To run this project on macOS ARM, you will
need to create an x86-64 installation of Node.js and run the Oracle database
client through Rosetta.

The installation steps are the same as above, but you'll need to install an
x86-64 version of Node.js first and activate it everytime you use this project.
[Here's a tutorial][6] on how to do that.

[6]: https://gist.github.com/LeZuse/bf838718ff2689c5fc035c5a6825a11c

### Updating MIT configuration files
The configuration files required to connect to the Data Warehouse are included
in the `warehouse-conf` directory. These are unlikely to be updated, but if
they are, you will need to update them from [the MIT knowledge base][7].
Extract the zip file; move `ldap.ora` and `sqlnet.ora` to `warehouse-conf`.
Replace whatever placeholder is currently set for the `SQLNET.CRYPTO_SEED`
entry with `"#DYNAMICALLY_GENERATED_RANDOM_SEED#"`.

[7]: http://kb.mit.edu/confluence/display/istcontrib/Manual+Oracle+11gR2+Installation#ManualOracle11gR2Installation-IMPORTANTInstalltheMITOracleConfigurationFiles

## Usage

```console
$ npm install
$ npm start 6.1220
```

This is still a prototype script for now.

<!-- vim: set tw=80: -->
