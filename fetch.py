import os
import sys

import oracledb

CURRENT_YEAR = 2023
MIN_YEAR = 2016

def normalize_subject_id(subject_id):
    """
    Normalize a subject ID by stripping leading/trailing whitespace and the "J"
    suffix for joint subjects.
    """
    return subject_id.strip().rstrip("J")

if __name__ == "__main__":
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
            out = {}

            cursor.execute("""
                SELECT * FROM cis_course_catalog
                WHERE subject_id=:subject
                AND academic_year >= :min_year
                ORDER BY academic_year DESC
            """, subject=subject, min_year=MIN_YEAR)

            # Return results as dict
            columns = [col[0].lower() for col in cursor.description]
            cursor.rowfactory = lambda *args: dict(zip(columns, args))

            row = cursor.fetchone()

            out["subject_id"] = row["subject_id"]
            out["title"] = row["subject_title"]
            out["total_units"] = row["total_units"]
            out["offered_fall"] = row["is_offered_fall_term"] == "Y"
            out["offered_IAP"] = row["is_offered_iap"] == "Y"
            out["offered_spring"] = row["is_offered_spring_term"] == "Y"
            out["offered_summer"] = row["is_offered_summer_term"] == "Y"
            out["public"] = True
            out["level"] = row["hgn_code"]

            if int(row["academic_year"]) < CURRENT_YEAR:
                # This is considered a historical subject (for
                # compatibility with FireRoad)
                out["is_historical"] = True
                out["source_semester"] = "spring-" + row["academic_year"]

            if row["joint_subjects"] is not None:
                out["joint_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["joint_subjects"].split(",")
                ]

            if row["equivalent_subjects"] is not None:
                out["equivalent_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["equivalent_subjects"].split(",")
                ]

            if row["meets_with_subjects"] is not None:
                out["meets_with_subjects"] = [
                    normalize_subject_id(x)
                    for x in row["meets_with_subjects"].split(",")
                ]

            for k, v in out.items():
                print(k.ljust(20) + str(v))
